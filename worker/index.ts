/**
 * Image Review Portal: reviewers pin comments on images, compare versions and approve them.
 *
 * The Worker sees every request before the static assets (run_worker_first), so /api/* and the
 * image files always pass through the session check, and a client side route such as /image/abc
 * opened from an email falls back to the single page app instead of a 404.
 */
import { Hono } from 'hono';
import type { Env, User } from './types';
import { withRetry } from './d1-retry';
import { serveFromR2 } from './media';
import { detectImageMime, extensionFor, maxUpload } from './upload-guard';
import {
  CSRF_COOKIE, clearedCookies, csrfCookie, generateCode, newId, randomToken, readSession,
  safeEqual, sessionCookie, sha256hex,
} from './auth';
import { applyRateLimit, clientIp, consumeRateLimit } from './rate-limit';
import {
  HttpError, MAX_REQUIRED_APPROVALS, accessTo, approve, createComment, imageStatus, imageWithAccess,
  isAdmin, need, needAdmin, needUpload, reply, setCommentStatus, summary, unapprove,
} from './logic';
import { loginMail, sendMail } from './mail';

type Vars = { user: User | null };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const appUrl = (env: Env) => (env.APP_URL || '').replace(/\/$/, '');
const appName = (env: Env) => env.APP_NAME || 'Image Review Portal';
const CODE_MINUTES = 90;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function limit(c: any, rule: string, max: number, seconds: number, message?: string) {
  const r = await consumeRateLimit(c.env.RATE_LIMIT, rule, clientIp(c) || 'unknown', max, seconds);
  return applyRateLimit(c, r, max, message);
}

// --- security headers -------------------------------------------------------------------------

app.use('*', async (c, next) => {
  await next();
  const res = new Response(c.res.body, c.res);
  const h = res.headers;
  h.set('Content-Security-Policy', ["default-src 'self'", "img-src 'self' data: blob:", "style-src 'self'", "script-src 'self'",
    "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"].join('; '));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.res = res;
});

// --- session ----------------------------------------------------------------------------------

app.use('*', async (c, next) => {
  if (!c.env.SESSION_SECRET || c.env.SESSION_SECRET.length < 32) {
    return c.json({ error: 'server_misconfigured' }, 500);
  }
  const s = await readSession(c.req.header('cookie'), c.env);
  let user: User | null = null;
  if (s) {
    const u = await c.env.DB.prepare('SELECT id, email, name, session_from FROM users WHERE id = ?').bind(s.uid).first<User>();
    // "Sign out everywhere" sets session_from: older sessions stop working.
    if (u && !(u.session_from && s.born < u.session_from * 1000)) user = u;
  }
  c.set('user', user);
  await next();
});

/** CSRF double-submit on every write, except the login endpoints (they have no session yet). */
app.use('/api/*', async (c, next) => {
  const writes = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(c.req.method);
  const exempt = c.req.path === '/api/auth/code' || c.req.path === '/api/auth/verify';
  if (writes && !exempt) {
    const cookie = (c.req.header('cookie') || '').match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`));
    const header = c.req.header('x-csrf-token');
    if (!cookie || !header || !safeEqual(cookie[1] as string, header)) return c.json({ error: 'csrf' }, 403);
  }
  await next();
});

function me(c: any): User {
  const u = c.get('user') as User | null;
  if (!u) throw new HttpError(401, 'not_signed_in');
  return u;
}

app.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.code, ...(e.data ? { data: e.data } : {}) }, e.status as 400);
  console.log('[irp] error', e);
  return c.json({ error: 'internal' }, 500);
});

// --- sign in ----------------------------------------------------------------------------------

/** Who may sign in: admins, and anyone an admin has invited to a project. */
async function mayEnter(env: Env, email: string): Promise<boolean> {
  if (isAdmin(env, email)) return true;
  return !!(await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first());
}

app.post('/api/auth/code', async (c) => {
  const limited = await limit(c, 'auth', 15, 3600, 'too_many_codes');
  if (limited) return limited;
  const { email } = await c.req.json<{ email?: string }>().catch(() => ({ email: '' }));
  const clean = (email || '').trim().toLowerCase();
  // Same answer and same delay for everybody: the list of known emails cannot be guessed.
  const started = Date.now();
  const same = async () => {
    const rest = 350 - (Date.now() - started);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    return c.json({ ok: true });
  };
  if (!clean || !EMAIL_RE.test(clean) || !(await mayEnter(c.env, clean))) return same();
  const perMailbox = await consumeRateLimit(c.env.RATE_LIMIT, 'auth-email', clean, 6, 3600);
  if (!perMailbox.allowed) return same();

  const token = randomToken();
  const code = generateCode();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE login_codes SET used = unixepoch(), link_used = unixepoch() WHERE email = ? AND (used IS NULL OR link_used IS NULL)').bind(clean),
    c.env.DB.prepare('INSERT INTO login_codes (token_hash, email, code, expires) VALUES (?, ?, ?, unixepoch() + ?)')
      .bind(await sha256hex(token), clean, code, CODE_MINUTES * 60),
  ]);
  const origin = appUrl(c.env) || new URL(c.req.url).origin;
  const mail = loginMail(appName(c.env), code, `${origin}/api/auth/link?token=${token}`);
  c.executionCtx.waitUntil(sendMail(c.env, clean, mail).then((ok) => {
    if (ok) return;
    if (c.env.DEV_MODE === '1') console.log('[irp] DEV_MODE: no mail sent. Code for', clean, '=', code);
    else console.log('[irp] no mail sent (RESEND_API_KEY or MAIL_FROM missing, or send failed). Set DEV_MODE=1 locally to print the code.');
  }));
  return same();
});

async function signIn(c: any, email: string) {
  let u = await c.env.DB.prepare('SELECT id, email, name, session_from FROM users WHERE email = ?').bind(email).first() as User | null;
  if (!u) {
    await c.env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(newId('u'), email).run();
    u = await c.env.DB.prepare('SELECT id, email, name, session_from FROM users WHERE email = ?').bind(email).first() as User;
  }
  c.header('Set-Cookie', await sessionCookie(u, c.env), { append: true });
  c.header('Set-Cookie', csrfCookie(), { append: true });
  await c.env.DB.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').bind(u.id).run();
}

app.post('/api/auth/verify', async (c) => {
  // Login CSRF: this route is exempt from the CSRF token, so only a real JSON request is accepted.
  // A cross-site form or fetch() with no preflight can only send text/plain, urlencoded or multipart.
  if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') || '')) return c.json({ error: 'unsupported_media_type' }, 415);
  const limited = await limit(c, 'verify', 30, 3600, 'too_many_attempts');
  if (limited) return limited;
  const body = await c.req.json<{ email?: string; code?: string }>().catch(() => ({} as { email?: string; code?: string }));
  const email = (body.email || '').trim().toLowerCase();
  const digits = (body.code || '').replace(/\s/g, '');
  if (!email || !/^\d{6}$/.test(digits)) return c.json({ error: 'invalid_code' }, 400);
  const row = await c.env.DB.prepare(`SELECT token_hash, code FROM login_codes
      WHERE email = ? AND used IS NULL AND link_used IS NULL AND expires > unixepoch() ORDER BY created DESC LIMIT 1`)
    .bind(email).first<{ token_hash: string; code: string }>();
  if (!row) return c.json({ error: 'code_expired' }, 400);
  const slot = await c.env.DB.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE token_hash = ? AND attempts < 5').bind(row.token_hash).run();
  if (!slot.meta.changes) return c.json({ error: 'too_many_attempts' }, 429);
  if (!safeEqual(row.code, digits)) return c.json({ error: 'wrong_code' }, 400);
  // One email, one sign-in: burn code AND link together, and only if neither was used yet.
  const burn = await c.env.DB.prepare('UPDATE login_codes SET used = unixepoch(), link_used = unixepoch() WHERE token_hash = ? AND used IS NULL AND link_used IS NULL AND expires > unixepoch()')
    .bind(row.token_hash).run();
  if (!burn.meta.changes) return c.json({ error: 'code_expired' }, 400);
  await signIn(c, email);
  return c.json({ ok: true });
});

app.get('/api/auth/link', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.redirect('/?error=link');
  const hash = await sha256hex(token);
  // Atomic: a single conditional UPDATE burns code and link together; a second use changes no row.
  const row = await c.env.DB.prepare('UPDATE login_codes SET used = unixepoch(), link_used = unixepoch() WHERE token_hash = ? AND used IS NULL AND link_used IS NULL AND expires > unixepoch() RETURNING email')
    .bind(hash).first<{ email: string }>();
  if (!row) return c.redirect('/?error=expired');
  await signIn(c, row.email);
  return c.redirect('/');
});

app.post('/api/auth/logout', (c) => {
  for (const k of clearedCookies) c.header('Set-Cookie', k, { append: true });
  return c.json({ ok: true });
});

app.get('/api/me', (c) => {
  const u = me(c);
  return c.json({ id: u.id, email: u.email, name: u.name || u.email.split('@')[0], admin: isAdmin(c.env, u.email) });
});

// --- projects ---------------------------------------------------------------------------------

function required(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REQUIRED_APPROVALS) throw new HttpError(400, 'invalid_required_approvals');
  return n;
}

app.get('/api/projects', async (c) => {
  const u = me(c);
  const admin = isAdmin(c.env, u.email);
  const sql = admin
    ? `SELECT p.id, p.name, p.required_approvals, m.role FROM projects p LEFT JOIN members m ON m.project_id = p.id AND m.user_id = ?1 ORDER BY p.created DESC`
    : `SELECT p.id, p.name, p.required_approvals, m.role FROM projects p JOIN members m ON m.project_id = p.id AND m.user_id = ?1 ORDER BY p.created DESC`;
  const { results } = await c.env.DB.prepare(sql).bind(u.id).all();
  return c.json({ projects: results ?? [] });
});

app.post('/api/projects', async (c) => {
  const u = me(c);
  if (!isAdmin(c.env, u.email)) throw new HttpError(403, 'forbidden');
  const body = await c.req.json<{ name?: string; required_approvals?: unknown }>().catch(() => ({} as { name?: string; required_approvals?: unknown }));
  const name = (body.name || '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'name_required');
  const id = newId('p');
  await c.env.DB.prepare('INSERT INTO projects (id, name, required_approvals, created_by) VALUES (?, ?, ?, ?)')
    .bind(id, name, body.required_approvals === undefined ? 1 : required(body.required_approvals), u.id).run();
  return c.json({ id }, 201);
});

app.patch('/api/projects/:id', async (c) => {
  const u = me(c);
  const access = await accessTo(c.env, u, c.req.param('id'));
  needAdmin(access);
  const body = await c.req.json<{ name?: string; required_approvals?: unknown }>().catch(() => ({} as { name?: string; required_approvals?: unknown }));
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'name_required');
    await c.env.DB.prepare('UPDATE projects SET name = ? WHERE id = ?').bind(name, access.project_id).run();
  }
  if (body.required_approvals !== undefined) {
    await c.env.DB.prepare('UPDATE projects SET required_approvals = ? WHERE id = ?').bind(required(body.required_approvals), access.project_id).run();
  }
  return c.json({ ok: true });
});

app.get('/api/projects/:id', async (c) => {
  const u = me(c);
  const access = await accessTo(c.env, u, c.req.param('id'));
  const pid = access.project_id;
  const [project, members, images] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, name, required_approvals FROM projects WHERE id = ?').bind(pid),
    c.env.DB.prepare(`SELECT m.user_id AS id, m.role, u.email, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.added`).bind(pid),
    c.env.DB.prepare(`
      WITH cm AS (SELECT c.image_id, SUM(c.status = 'open') AS open, SUM(c.status = 'addressed') AS addressed
                    FROM comments c JOIN images i ON i.id = c.image_id WHERE i.project_id = ?1 GROUP BY c.image_id),
           ap AS (SELECT a.image_id, COUNT(DISTINCT a.user_id) AS n
                    FROM approvals a JOIN images i ON i.id = a.image_id AND a.version_id = i.current_version
                    JOIN members m ON m.project_id = i.project_id AND m.user_id = a.user_id AND m.role = 'reviewer'
                   WHERE i.project_id = ?1 AND a.revoked IS NULL GROUP BY a.image_id)
      SELECT i.id, i.title, i.current_version, v.number AS version_number,
             COALESCE(cm.open, 0) AS open, COALESCE(cm.addressed, 0) AS addressed, COALESCE(ap.n, 0) AS approvals
        FROM images i LEFT JOIN versions v ON v.id = i.current_version LEFT JOIN cm ON cm.image_id = i.id LEFT JOIN ap ON ap.image_id = i.id
       WHERE i.project_id = ?1 ORDER BY i.created`).bind(pid),
  ]);
  const p = (project!.results as any[])[0];
  const list = ((images!.results as any[]) ?? []).map((i) => ({
    id: i.id, title: i.title, version: i.version_number, current_version: i.current_version,
    open: i.open, addressed: i.addressed, approvals: i.approvals,
    status: imageStatus({ current: i.current_version, open: i.open, addressed: i.addressed, approvals: i.approvals, required: p.required_approvals }),
  }));
  const people = ((members!.results as any[]) ?? []).map((m) => ({
    id: m.id, role: m.role, name: m.name || m.email.split('@')[0], ...(access.admin ? { email: m.email } : {}),
  }));
  return c.json({ project: p, role: access.role, admin: access.admin, members: people, images: list });
});

app.post('/api/projects/:id/members', async (c) => {
  const u = me(c);
  const access = await accessTo(c.env, u, c.req.param('id'));
  needAdmin(access);
  const body = await c.req.json<{ email?: string; role?: string; name?: string }>().catch(() => ({} as { email?: string; role?: string; name?: string }));
  const email = (body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'invalid_email');
  if (body.role !== 'reviewer' && body.role !== 'author') throw new HttpError(400, 'invalid_role');
  const found = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  const userId = found?.id ?? newId('u');
  const name = (body.name || '').trim().slice(0, 80) || null;
  const stmts = [];
  if (!found) stmts.push(c.env.DB.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').bind(userId, email, name));
  else if (name) stmts.push(c.env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, userId));
  stmts.push(c.env.DB.prepare('INSERT INTO members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role')
    .bind(access.project_id, userId, body.role));
  await c.env.DB.batch(stmts);
  return c.json({ id: userId }, 201);
});

app.delete('/api/projects/:id/members/:userId', async (c) => {
  const u = me(c);
  const access = await accessTo(c.env, u, c.req.param('id'));
  needAdmin(access);
  await c.env.DB.prepare('DELETE FROM members WHERE project_id = ? AND user_id = ?').bind(access.project_id, c.req.param('userId')).run();
  return c.json({ ok: true });
});

// --- uploads ----------------------------------------------------------------------------------

/** Reads the request body as an image, within the size limit, confirming the type from the bytes. */
async function readImage(c: any) {
  const max = maxUpload(c.env.MAX_UPLOAD_BYTES);
  const declared = Number(c.req.header('content-length') || 0);
  if (!declared) throw new HttpError(411, 'content_length_required');
  if (declared > max) throw new HttpError(413, 'too_large', { max });
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > max) throw new HttpError(413, 'too_large', { max });
  const mime = detectImageMime(bytes);
  if (!mime) throw new HttpError(415, 'images_only');
  const raw = decodeURIComponent(c.req.header('x-filename') || '').replace(/[\\/\r\n\t\x00-\x1f]/g, '_').slice(0, 120);
  const filename = raw || `image.${extensionFor(mime)}`;
  return { bytes, mime, filename, sha256: await sha256hex(bytes) };
}

async function saveVersion(c: any, user: User, projectId: string, imageId: string, newImageTitle: string | null) {
  const file = await readImage(c);
  const dup = await c.env.DB.prepare('SELECT number FROM versions WHERE image_id = ? AND sha256 = ?').bind(imageId, file.sha256).first();
  if (dup) throw new HttpError(409, 'same_file_already_uploaded');
  const versionId = newId('v');
  const key = `projects/${projectId}/${imageId}/${versionId}`;
  const note = (c.req.query('note') || '').trim().slice(0, 1000) || null;
  const resolves = (c.req.query('resolves') || '').split(',').map((s: string) => s.trim()).filter(Boolean).slice(0, 100);
  await c.env.MEDIA.put(key, file.bytes, { httpMetadata: { contentType: file.mime } });
  const stmts = [];
  if (newImageTitle !== null) {
    stmts.push(c.env.DB.prepare('INSERT INTO images (id, project_id, title) VALUES (?, ?, ?)').bind(imageId, projectId, newImageTitle));
  }
  stmts.push(
    c.env.DB.prepare(`INSERT INTO versions (id, image_id, number, filename, sha256, bytes, mime, r2_key, note, author)
      VALUES (?1, ?2, (SELECT COALESCE(MAX(number), 0) + 1 FROM versions WHERE image_id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
      .bind(versionId, imageId, file.filename, file.sha256, file.bytes.length, file.mime, key, note, user.id),
    c.env.DB.prepare('UPDATE images SET current_version = ? WHERE id = ?').bind(versionId, imageId),
    // Threads the author says are fixed by this version become "addressed" (only the ones of this image).
    ...resolves.map((cid: string) => c.env.DB.prepare("UPDATE comments SET status = 'addressed', updated = unixepoch() WHERE id = ? AND image_id = ? AND status = 'open'").bind(cid, imageId)),
    c.env.DB.prepare('INSERT INTO events (project_id, image_id, type, user_id, data) VALUES (?, ?, ?, ?, ?)')
      .bind(projectId, imageId, 'version', user.id, JSON.stringify({ version: versionId })),
  );
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    await c.env.MEDIA.delete(key).catch(() => {});
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'upload_conflict_retry');
    throw e;
  }
  return { image: imageId, version: versionId };
}

app.post('/api/projects/:id/images', async (c) => {
  const u = me(c);
  const access = await accessTo(c.env, u, c.req.param('id'));
  needUpload(access);
  const limited = await limit(c, 'upload', 120, 3600); if (limited) return limited;
  const title = (c.req.query('title') || '').trim().slice(0, 160);
  if (!title) throw new HttpError(400, 'title_required');
  return c.json(await saveVersion(c, u, access.project_id, newId('i'), title), 201);
});

app.post('/api/images/:id/versions', async (c) => {
  const u = me(c);
  const { image, access } = await imageWithAccess(c.env, u, c.req.param('id'));
  needUpload(access);
  const limited = await limit(c, 'upload', 120, 3600); if (limited) return limited;
  return c.json(await saveVersion(c, u, image.project_id, image.id, null), 201);
});

// --- images, comments, approvals --------------------------------------------------------------

app.get('/api/images/:id', async (c) => {
  const u = me(c);
  const { image, access } = await imageWithAccess(c.env, u, c.req.param('id'));
  const [versions, comments, messages, approvals, members, project] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT id, number, filename, bytes, mime, note, author, created FROM versions WHERE image_id = ? ORDER BY number').bind(image.id),
    c.env.DB.prepare('SELECT id, version_id, number, x, y, status, author, created FROM comments WHERE image_id = ? ORDER BY number').bind(image.id),
    c.env.DB.prepare('SELECT m.id, m.comment_id, m.author, m.body, m.created FROM messages m JOIN comments c ON c.id = m.comment_id WHERE c.image_id = ? ORDER BY m.created').bind(image.id),
    c.env.DB.prepare('SELECT id, version_id, user_id, created FROM approvals WHERE image_id = ? AND revoked IS NULL ORDER BY created').bind(image.id),
    c.env.DB.prepare('SELECT m.user_id AS id, m.role, u.email, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?').bind(image.project_id),
    c.env.DB.prepare('SELECT id, name, required_approvals FROM projects WHERE id = ?').bind(image.project_id),
  ]);
  const people = ((members!.results as any[]) ?? []).map((m) => ({ id: m.id, role: m.role, name: m.name || m.email.split('@')[0] }));
  const reviewers = new Set(people.filter((p) => p.role === 'reviewer').map((p) => p.id));
  const live = ((approvals!.results as any[]) ?? []).filter((a) => a.version_id === image.current_version && reviewers.has(a.user_id));
  const proj = (project!.results as any[])[0];
  return c.json({
    image: { id: image.id, title: image.title, current_version: image.current_version, project_id: image.project_id },
    project: proj,
    role: access.role, admin: access.admin,
    versions: versions!.results, comments: comments!.results, messages: messages!.results,
    people,
    ...(await summary(c.env, image.id)),
    signed_by: [...new Set(live.map((a) => a.user_id))],
  });
});

app.post('/api/images/:id/comments', async (c) => {
  const u = me(c);
  const limited = await limit(c, 'write', 240, 3600); if (limited) return limited;
  const body = await c.req.json().catch(() => ({}));
  return c.json(await createComment(c.env, u, c.req.param('id'), body), 201);
});

app.post('/api/comments/:id/messages', async (c) => {
  const u = me(c);
  const limited = await limit(c, 'write', 240, 3600); if (limited) return limited;
  const { body } = await c.req.json<{ body?: string }>().catch(() => ({ body: '' }));
  return c.json(await reply(c.env, u, c.req.param('id'), body), 201);
});

app.post('/api/comments/:id/status', async (c) => {
  const u = me(c);
  const { status } = await c.req.json<{ status?: string }>().catch(() => ({ status: '' }));
  return c.json(await setCommentStatus(c.env, u, c.req.param('id'), status || ''));
});

app.post('/api/images/:id/approve', async (c) => {
  const u = me(c);
  const { version } = await c.req.json<{ version?: string }>().catch(() => ({ version: undefined }));
  return c.json(await approve(c.env, u, c.req.param('id'), version));
});

app.post('/api/images/:id/unapprove', async (c) => {
  const u = me(c);
  return c.json(await unapprove(c.env, u, c.req.param('id')));
});

// --- files ------------------------------------------------------------------------------------

app.get('/api/versions/:id/file', async (c) => {
  const u = me(c);
  const v = await c.env.DB.prepare('SELECT image_id, filename, sha256, mime, r2_key FROM versions WHERE id = ?')
    .bind(c.req.param('id')).first<{ image_id: string; filename: string; sha256: string; mime: string; r2_key: string }>();
  if (!v) throw new HttpError(404, 'not_found');
  await imageWithAccess(c.env, u, v.image_id); // membership check: outsiders get 404
  const download = c.req.query('download') === '1';
  return serveFromR2(c.env, v.r2_key, c.req.raw, { filename: v.filename, inline: !download, etag: v.sha256 });
});

app.get('/api/health', (c) => c.json({ ok: true }));

// --- single page app --------------------------------------------------------------------------

app.all('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'no_such_route' }, 404);
  const direct = await c.env.ASSETS.fetch(c.req.raw);
  if (direct.status !== 404) return direct;
  const url = new URL(c.req.url);
  url.pathname = '/';
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

export { app };

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    env.DB = withRetry(env.DB);
    return app.fetch(req, env, ctx);
  },
  /** Daily housekeeping: expired login codes. */
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    const db = withRetry(env.DB);
    ctx.waitUntil(db.prepare('DELETE FROM login_codes WHERE expires < unixepoch() - 86400').run().then(() => undefined));
  },
};
