import { describe, expect, it } from 'vitest';
import { Client, firstImage, makeHarness, samplePng, setup } from './helpers';

describe('access control', () => {
  it('rejects anonymous requests with 401', async () => {
    const h = makeHarness();
    for (const path of ['/api/me', '/api/projects', '/api/projects/p_x', '/api/images/i_x', '/api/versions/v_x/file']) {
      const r = await h.call(path);
      expect(r.status, path).toBe(401);
    }
  });

  it('a user from another project gets 404 on everything of a project they do not belong to', async () => {
    const h = makeHarness();
    const { admin, projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);
    const { comment } = (await (await people['r1@example.com']!.post(`/api/images/${img.image}/comments`, { body: 'Hello' })).json()) as { comment: string };

    // a second project with its own reviewer
    const other = await (await admin.post('/api/projects', { name: 'Other project' })).json() as { id: string };
    await admin.post(`/api/projects/${other.id}/members`, { email: 'outsider@example.com', role: 'reviewer' });
    const outsider = await new Client(h, 'outsider@example.com').login();

    const checks: [string, Response][] = [
      ['project', await outsider.get(`/api/projects/${projectId}`)],
      ['image', await outsider.get(`/api/images/${img.image}`)],
      ['file', await outsider.get(`/api/versions/${img.version}/file`)],
      ['new comment', await outsider.post(`/api/images/${img.image}/comments`, { body: 'let me in' })],
      ['reply', await outsider.post(`/api/comments/${comment}/messages`, { body: 'let me in' })],
      ['comment status', await outsider.post(`/api/comments/${comment}/status`, { status: 'resolved' })],
      ['approve', await outsider.post(`/api/images/${img.image}/approve`, { version: img.version })],
      ['upload version', await outsider.upload(`/api/images/${img.image}/versions`, samplePng())],
      ['upload image', await outsider.upload(`/api/projects/${projectId}/images?title=x`, samplePng())],
    ];
    for (const [name, res] of checks) expect(res.status, name).toBe(404);

    // and the project list only shows their own project
    const list = await (await outsider.get('/api/projects')).json() as { projects: { id: string }[] };
    expect(list.projects.map((p) => p.id)).toEqual([other.id]);
    // nothing was written
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as any).n).toBe(0);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n).toBe(1);
  });

  it('roles are enforced inside a project', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const reviewer = people['r1@example.com']!;
    const author = people['a@example.com']!;
    const img = await firstImage(author, projectId);

    expect((await reviewer.upload(`/api/projects/${projectId}/images?title=x`, samplePng())).status).toBe(403);
    expect((await reviewer.upload(`/api/images/${img.image}/versions`, samplePng())).status).toBe(403);
    expect((await author.post(`/api/images/${img.image}/comments`, { body: 'x' })).status).toBe(403);
    expect((await author.post(`/api/images/${img.image}/approve`, { version: img.version })).status).toBe(403);
    // neither can manage the project
    expect((await reviewer.post('/api/projects', { name: 'mine' })).status).toBe(403);
    expect((await author.post(`/api/projects/${projectId}/members`, { email: 'x@example.com', role: 'reviewer' })).status).toBe(403);
    expect((await reviewer.req(`/api/projects/${projectId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ required_approvals: 1 }) })).status).toBe(403);
  });

  it('writes without the CSRF header are refused', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);
    const r = await people['r1@example.com']!.req(`/api/images/${img.image}/comments`, {
      method: 'POST', csrf: false, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'x' }),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'csrf' });
  });

  it('only people an admin has invited can sign in, and the answer does not reveal who they are', async () => {
    const h = makeHarness();
    const stranger = await h.call('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }) });
    const admin = await h.call('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com' }) });
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toEqual(await admin.json());
    const n = (email: string) => (h.db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ?').get(email) as any).n;
    expect(n('nobody@example.com')).toBe(0);
    expect(n('admin@example.com')).toBe(1);
  });

  it('a wrong code is refused and five wrong tries lock that code', async () => {
    const h = makeHarness();
    await h.call('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com' }) });
    const real = (h.db.prepare('SELECT code FROM login_codes').get() as any).code as string;
    const wrong = real === '000000' ? '111111' : '000000';
    const post = (code: string) => h.call('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', code }) });
    for (let i = 0; i < 5; i++) expect((await post(wrong)).status).toBe(400);
    expect((await post(real)).status).toBe(429);
  });

  it('a forged session cookie is ignored', async () => {
    const h = makeHarness();
    const r = await h.call('/api/me', { headers: { cookie: 'irp_session=eyJ1aWQiOiJ1X3gifQ.AAAA' } });
    expect(r.status).toBe(401);
  });
});

describe('sign-in is single use', () => {
  const json = { 'content-type': 'application/json' };
  async function start() {
    const h = makeHarness();
    await h.call('/api/auth/code', { method: 'POST', headers: json, body: JSON.stringify({ email: 'admin@example.com' }) });
    const row = h.db.prepare('SELECT code FROM login_codes').get() as any;
    // The token is only in the mail; plant a known one so the link can be tested.
    h.db.prepare('UPDATE login_codes SET token_hash = ?').run(await sha('tok-1'));
    return { h, code: row.code as string };
  }
  async function sha(t: string) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const verify = (h: any, code: string) => h.call('/api/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ email: 'admin@example.com', code }) });
  const link = (h: any) => h.call('/api/auth/link?token=tok-1');
  const signedIn = (r: Response) => r.headers.get('set-cookie')?.includes('irp_session') ?? false;

  it('verify with text/plain (cross-site login CSRF) is refused with 415', async () => {
    const { h, code } = await start();
    const r = await h.call('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ email: 'admin@example.com', code }) });
    expect(r.status).toBe(415);
    expect(signedIn(r)).toBe(false);
    const none = await h.call('/api/auth/verify', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', code }) });
    expect(none.status).toBe(415);
    expect((await verify(h, code)).status).toBe(200);
  });

  it('code then link gives one sign-in', async () => {
    const { h, code } = await start();
    expect((await verify(h, code)).status).toBe(200);
    const l = await link(h);
    expect(l.headers.get('location')).toContain('error=expired');
    expect(signedIn(l)).toBe(false);
  });

  it('link then code gives one sign-in', async () => {
    const { h, code } = await start();
    const l = await link(h);
    expect(signedIn(l)).toBe(true);
    const v = await verify(h, code);
    expect(v.status).toBe(400);
    expect(signedIn(v)).toBe(false);
  });

  it('two parallel link requests give one sign-in', async () => {
    const { h } = await start();
    const rs = await Promise.all([link(h), link(h)]);
    expect(rs.filter(signedIn).length).toBe(1);
  });

  it('two parallel code verifications give one sign-in', async () => {
    const { h, code } = await start();
    const rs = await Promise.all([verify(h, code), verify(h, code)]);
    expect(rs.filter(signedIn).length).toBe(1);
  });

  it('parallel code and link give one sign-in', async () => {
    const { h, code } = await start();
    const rs = await Promise.all([verify(h, code), link(h)]);
    expect(rs.filter(signedIn).length).toBe(1);
  });
});
