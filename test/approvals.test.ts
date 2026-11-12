import { describe, expect, it } from 'vitest';
import { imageStatus } from '../worker/logic';
import { Client, firstImage, makeHarness, samplePng, setup } from './helpers';

describe('imageStatus (pure rules)', () => {
  const base = { current: 'v1', open: 0, addressed: 0, approvals: 0, required: 2 };
  it('is empty without a version', () => expect(imageStatus({ ...base, current: null })).toBe('empty'));
  it('open comments win over signatures', () => expect(imageStatus({ ...base, open: 1, approvals: 2 })).toBe('changes_requested'));
  it('addressed comments ask for another look', () => expect(imageStatus({ ...base, addressed: 1, approvals: 2 })).toBe('needs_review'));
  it('needs N signatures, not N-1', () => {
    expect(imageStatus({ ...base, approvals: 1 })).toBe('partially_approved');
    expect(imageStatus({ ...base, approvals: 2 })).toBe('approved');
  });
});

describe('approval with N signatures', () => {
  it('needs 2 of 3 reviewers when required_approvals is 2', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { required: 2, reviewers: ['r1@example.com', 'r2@example.com', 'r3@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);

    let r = await people['r1@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'partially_approved', approvals: 1, required: 2, missing: 1 });

    r = await people['r2@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    expect(await r.json()).toMatchObject({ status: 'approved', approvals: 2, missing: 0 });
  });

  it('the same reviewer signing twice counts once', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { required: 2, reviewers: ['r1@example.com', 'r2@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);
    await people['r1@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    const r = await people['r1@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    expect(await r.json()).toMatchObject({ status: 'partially_approved', approvals: 1 });
  });

  it('a new version resets the signatures', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { required: 1, reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const author = people['a@example.com']!;
    const img = await firstImage(author, projectId);
    const ok = await people['r1@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    expect(await ok.json()).toMatchObject({ status: 'approved' });

    const v2 = await author.upload(`/api/images/${img.image}/versions?note=fixed`, samplePng());
    expect(v2.status).toBe(201);
    const detail = await (await people['r1@example.com']!.get(`/api/images/${img.image}`)).json() as any;
    expect(detail.status).toBe('awaiting_approval');
    expect(detail.approvals).toBe(0);
  });

  it('refuses to approve a version that is no longer the current one (409)', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const author = people['a@example.com']!;
    const img = await firstImage(author, projectId);
    await author.upload(`/api/images/${img.image}/versions`, samplePng());
    const r = await people['r1@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'version_changed' });
  });

  it('authors cannot sign (403)', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const author = people['a@example.com']!;
    const img = await firstImage(author, projectId);
    const r = await author.post(`/api/images/${img.image}/approve`, { version: img.version });
    expect(r.status).toBe(403);
  });

  it('an open comment blocks "approved" until it is resolved', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const reviewer = people['r1@example.com']!;
    const img = await firstImage(people['a@example.com']!, projectId);
    const pin = await reviewer.post(`/api/images/${img.image}/comments`, { x: 0.25, y: 0.75, body: 'Move this left' });
    expect(pin.status).toBe(201);
    const { comment } = (await pin.json()) as { comment: string };

    let r = await reviewer.post(`/api/images/${img.image}/approve`, { version: img.version });
    expect(await r.json()).toMatchObject({ status: 'changes_requested' });

    r = await reviewer.post(`/api/comments/${comment}/status`, { status: 'resolved' });
    expect(r.status).toBe(200);
    const detail = await (await reviewer.get(`/api/images/${img.image}`)).json() as any;
    expect(detail.status).toBe('approved');
  });

  it('revoking a signature lowers the count', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { required: 2, reviewers: ['r1@example.com', 'r2@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);
    await people['r1@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    await people['r2@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    const r = await people['r2@example.com']!.post(`/api/images/${img.image}/unapprove`);
    expect(await r.json()).toMatchObject({ status: 'partially_approved', approvals: 1 });
    // the row is kept, marked as revoked: the table is append-only
    const rows = h.db.prepare('SELECT COUNT(*) AS n, SUM(revoked IS NOT NULL) AS revoked FROM approvals').get() as any;
    expect(rows.n).toBe(2);
    expect(rows.revoked).toBe(1);
  });

  it('a reviewer who is removed from the project no longer counts', async () => {
    const h = makeHarness();
    const { admin, projectId, people } = await setup(h, { required: 2, reviewers: ['r1@example.com', 'r2@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);
    await people['r1@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    await people['r2@example.com']!.post(`/api/images/${img.image}/approve`, { version: img.version });
    const members = (await (await admin.get(`/api/projects/${projectId}`)).json() as any).members as { id: string; role: string; name: string }[];
    const r2 = members.find((m) => m.name === 'r2')!;
    const del = await admin.req(`/api/projects/${projectId}/members/${r2.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const detail = await (await admin.get(`/api/images/${img.image}`)).json() as any;
    expect(detail.approvals).toBe(1);
    expect(detail.status).toBe('partially_approved');
  });

  it('an author upload marks the listed threads as addressed, and a reviewer reply reopens them', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const reviewer = people['r1@example.com']!;
    const author = people['a@example.com']!;
    const img = await firstImage(author, projectId);
    const { comment } = (await (await reviewer.post(`/api/images/${img.image}/comments`, { body: 'Too dark' })).json()) as { comment: string };
    await author.upload(`/api/images/${img.image}/versions?resolves=${comment}&note=brighter`, samplePng());
    let detail = await (await reviewer.get(`/api/images/${img.image}`)).json() as any;
    expect(detail.comments[0].status).toBe('addressed');
    expect(detail.status).toBe('needs_review');
    await reviewer.post(`/api/comments/${comment}/messages`, { body: 'Still too dark' });
    detail = await (await reviewer.get(`/api/images/${img.image}`)).json() as any;
    expect(detail.comments[0].status).toBe('open');
  });
});

void Client;
