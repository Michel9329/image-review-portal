/**
 * Business rules: who can do what on a project, comment threads, and approvals with N signatures.
 * Every route goes through these functions, so the rules are written once.
 */
import type { Access, Env, Role, User } from './types';
import { newId } from './auth';

export class HttpError extends Error {
  constructor(public status: number, public code: string, public data?: unknown) { super(code); }
}

const BODY_MAX = 4000;
export const MAX_REQUIRED_APPROVALS = 20;

export function isAdmin(env: Env, email: string): boolean {
  return (env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}

/**
 * The access check. Used by EVERY route that touches a project, an image, a version or a
 * comment. A user who is not a member (and not an admin) gets 404, not 403, so ids cannot be probed.
 */
export async function accessTo(env: Env, user: User, projectId: string): Promise<Access> {
  const row = await env.DB.prepare('SELECT role FROM members WHERE project_id = ? AND user_id = ?')
    .bind(projectId, user.id).first<{ role: Role }>();
  const admin = isAdmin(env, user.email);
  if (!row && !admin) throw new HttpError(404, 'not_found');
  return { project_id: projectId, role: row?.role ?? null, admin };
}

export function need(a: Access, ...roles: Role[]): void {
  if (!a.role || !roles.includes(a.role)) throw new HttpError(403, 'forbidden');
}

/** Authors and admins may upload images and new versions. Admins do not have to add themselves as an author first. */
export function needUpload(a: Access): void {
  if (a.role !== 'author' && !a.admin) throw new HttpError(403, 'forbidden');
}

export function needAdmin(a: Access): void {
  if (!a.admin) throw new HttpError(403, 'forbidden');
}

export interface ImageRow { id: string; project_id: string; title: string; current_version: string | null }

export async function imageWithAccess(env: Env, user: User, imageId: string): Promise<{ image: ImageRow; access: Access }> {
  const image = await env.DB.prepare('SELECT id, project_id, title, current_version FROM images WHERE id = ?')
    .bind(imageId).first<ImageRow>();
  if (!image) throw new HttpError(404, 'not_found');
  return { image, access: await accessTo(env, user, image.project_id) };
}

export type ImageStatus = 'empty' | 'changes_requested' | 'needs_review' | 'awaiting_approval' | 'partially_approved' | 'approved';

/** The status is derived, never stored: a stored status drifts out of date at the first bug. */
export function imageStatus(i: { current: string | null; open: number; addressed: number; approvals: number; required: number }): ImageStatus {
  if (!i.current) return 'empty';
  if (i.open > 0) return 'changes_requested';
  if (i.addressed > 0) return 'needs_review';
  if (i.approvals >= i.required) return 'approved';
  return i.approvals > 0 ? 'partially_approved' : 'awaiting_approval';
}

export function cleanText(v: unknown): string {
  const t = String(v ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) throw new HttpError(400, 'empty_text');
  if (t.length > BODY_MAX) throw new HttpError(400, 'text_too_long');
  return t;
}

function eventStatement(env: Env, e: { project_id: string; image_id: string | null; type: string; user_id: string; data?: unknown }) {
  return env.DB.prepare('INSERT INTO events (project_id, image_id, type, user_id, data) VALUES (?, ?, ?, ?, ?)')
    .bind(e.project_id, e.image_id, e.type, e.user_id, e.data === undefined ? null : JSON.stringify(e.data));
}

/** A new comment thread. Reviewers (and admins) pin it to a point of a version, or leave it unpinned. */
export async function createComment(env: Env, user: User, imageId: string,
  input: { version?: string; x?: unknown; y?: unknown; body?: unknown }) {
  const { image, access } = await imageWithAccess(env, user, imageId);
  if (!(access.role === 'reviewer' || (access.admin && access.role === null))) throw new HttpError(403, 'forbidden');
  const body = cleanText(input.body);
  const versionId = typeof input.version === 'string' && input.version ? input.version : image.current_version;
  if (!versionId) throw new HttpError(409, 'image_has_no_version');
  const v = await env.DB.prepare('SELECT id FROM versions WHERE id = ? AND image_id = ?').bind(versionId, image.id).first();
  if (!v) throw new HttpError(400, 'unknown_version');
  const pinned = typeof input.x === 'number' && typeof input.y === 'number' && Number.isFinite(input.x) && Number.isFinite(input.y);
  const x = pinned ? Math.min(1, Math.max(0, input.x as number)) : null;
  const y = pinned ? Math.min(1, Math.max(0, input.y as number)) : null;
  const commentId = newId('c');
  const messageId = newId('m');
  // The number on the pin is the first free one for this image. If two people write at the same
  // instant, the unique index stops one of them and it is retried with the next number.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO comments (id, image_id, version_id, number, x, y, author)
          VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(number), 0) + 1 FROM comments WHERE image_id = ?2), ?4, ?5, ?6)`)
          .bind(commentId, image.id, versionId, x, y, user.id),
        env.DB.prepare('INSERT INTO messages (id, comment_id, author, body) VALUES (?, ?, ?, ?)').bind(messageId, commentId, user.id, body),
        eventStatement(env, { project_id: image.project_id, image_id: image.id, type: 'comment', user_id: user.id, data: { comment: commentId } }),
      ]);
      return { comment: commentId, message: messageId };
    } catch (e) {
      if (!String(e).includes('UNIQUE') || attempt === 2) throw e;
    }
  }
  throw new HttpError(500, 'comment_not_saved');
}

async function commentWithAccess(env: Env, user: User, commentId: string) {
  const c = await env.DB.prepare('SELECT id, image_id, status, author FROM comments WHERE id = ?')
    .bind(commentId).first<{ id: string; image_id: string; status: string; author: string }>();
  if (!c) throw new HttpError(404, 'not_found');
  const { image, access } = await imageWithAccess(env, user, c.image_id);
  return { c, image, access };
}

/** A reply. A reviewer replying on an "addressed" thread reopens it: the fix was not enough. */
export async function reply(env: Env, user: User, commentId: string, bodyRaw: unknown) {
  const { c, image, access } = await commentWithAccess(env, user, commentId);
  if (!access.role && !access.admin) throw new HttpError(403, 'forbidden');
  const body = cleanText(bodyRaw);
  const reopen = access.role === 'reviewer' && c.status === 'addressed';
  const id = newId('m');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, comment_id, author, body) VALUES (?, ?, ?, ?)').bind(id, c.id, user.id, body),
    env.DB.prepare('UPDATE comments SET status = ?, updated = unixepoch() WHERE id = ?').bind(reopen ? 'open' : c.status, c.id),
    eventStatement(env, { project_id: image.project_id, image_id: image.id, type: 'reply', user_id: user.id, data: { comment: c.id } }),
  ]);
  return { message: id, status: reopen ? 'open' : c.status };
}

/**
 * Status changes. Authors can mark a thread "addressed". Reviewers can resolve or reopen.
 */
export async function setCommentStatus(env: Env, user: User, commentId: string, status: string) {
  if (!['open', 'addressed', 'resolved'].includes(status)) throw new HttpError(400, 'unknown_status');
  const { c, image, access } = await commentWithAccess(env, user, commentId);
  if (status === 'addressed') need(access, 'author');
  else need(access, 'reviewer');
  await env.DB.batch([
    env.DB.prepare('UPDATE comments SET status = ?, updated = unixepoch() WHERE id = ?').bind(status, c.id),
    eventStatement(env, { project_id: image.project_id, image_id: image.id, type: 'comment_status', user_id: user.id, data: { comment: c.id, status } }),
  ]);
  return { status };
}

/**
 * Approve the version the reviewer had in front of them. If a newer version arrived in the
 * meantime the answer is 409: you approve what you have seen. Only reviewers sign. A signature
 * counts only on the current version, so uploading a new version resets the count.
 */
export async function approve(env: Env, user: User, imageId: string, seenVersion: string | undefined) {
  const { image, access } = await imageWithAccess(env, user, imageId);
  need(access, 'reviewer');
  if (!image.current_version) throw new HttpError(409, 'image_has_no_version');
  if (seenVersion !== image.current_version) throw new HttpError(409, 'version_changed', { current: image.current_version });
  const v = await env.DB.prepare('SELECT sha256 FROM versions WHERE id = ?').bind(image.current_version).first<{ sha256: string }>();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO approvals (id, image_id, version_id, user_id, email, sha256) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(newId('a'), image.id, image.current_version, user.id, user.email, v?.sha256 ?? ''),
    // Signing means the reviewer saw the fixes: their own "addressed" threads are resolved.
    env.DB.prepare("UPDATE comments SET status = 'resolved', updated = unixepoch() WHERE image_id = ? AND author = ? AND status = 'addressed'")
      .bind(image.id, user.id),
    eventStatement(env, { project_id: image.project_id, image_id: image.id, type: 'approved', user_id: user.id, data: { version: image.current_version } }),
  ]);
  return summary(env, image.id);
}

export async function unapprove(env: Env, user: User, imageId: string) {
  const { image, access } = await imageWithAccess(env, user, imageId);
  need(access, 'reviewer');
  await env.DB.batch([
    env.DB.prepare('UPDATE approvals SET revoked = unixepoch() WHERE image_id = ? AND user_id = ? AND revoked IS NULL').bind(image.id, user.id),
    eventStatement(env, { project_id: image.project_id, image_id: image.id, type: 'approval_revoked', user_id: user.id }),
  ]);
  return summary(env, image.id);
}

/** Counts for one image: status, signatures on the current version, signatures still needed. */
export async function summary(env: Env, imageId: string) {
  const row = await env.DB.prepare(`
    WITH cm AS (SELECT SUM(status = 'open') AS open, SUM(status = 'addressed') AS addressed FROM comments WHERE image_id = ?1),
         ap AS (SELECT COUNT(DISTINCT a.user_id) AS n FROM approvals a JOIN images i ON i.id = a.image_id AND a.version_id = i.current_version
                  JOIN members m ON m.project_id = i.project_id AND m.user_id = a.user_id AND m.role = 'reviewer'
                 WHERE a.image_id = ?1 AND a.revoked IS NULL)
    SELECT i.current_version AS current, p.required_approvals AS required,
           COALESCE(cm.open, 0) AS open, COALESCE(cm.addressed, 0) AS addressed, ap.n AS approvals
      FROM images i JOIN projects p ON p.id = i.project_id, cm, ap WHERE i.id = ?1`)
    .bind(imageId).first<{ current: string | null; required: number; open: number; addressed: number; approvals: number }>();
  if (!row) throw new HttpError(404, 'not_found');
  return { status: imageStatus(row), approvals: row.approvals, required: row.required, missing: Math.max(0, row.required - row.approvals) };
}
