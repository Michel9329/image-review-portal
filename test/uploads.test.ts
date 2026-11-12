import { describe, expect, it } from 'vitest';
import { detectImageMime } from '../worker/upload-guard';
import { firstImage, makeHarness, samplePng, setup } from './helpers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('detectImageMime', () => {
  it('knows the four image types from their bytes', () => {
    expect(detectImageMime(samplePng())).toBe('image/png');
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageMime(enc('GIF89a....'))).toBe('image/gif');
    expect(detectImageMime(enc('RIFF....WEBPVP8 '))).toBe('image/webp');
  });
  it('refuses SVG, PDF, HTML and empty files', () => {
    expect(detectImageMime(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(detectImageMime(enc('%PDF-1.7'))).toBeNull();
    expect(detectImageMime(enc('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectImageMime(new Uint8Array())).toBeNull();
  });
});

describe('upload endpoints', () => {
  it('accepts an image and serves it back to a member with safe headers', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);
    const r = await people['r1@example.com']!.get(`/api/versions/${img.version}/file`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-disposition')).toContain('inline');
    expect(r.headers.get('cache-control')).toContain('private');
  });

  it('refuses a non-image even when it is named .png (415)', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { authors: ['a@example.com'] });
    const author = people['a@example.com']!;
    const r = await author.upload(`/api/projects/${projectId}/images?title=x`, enc('<script>alert(1)</script>'), 'evil.png');
    expect(r.status).toBe(415);
    const svg = await author.upload(`/api/projects/${projectId}/images?title=x`, enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg');
    expect(svg.status).toBe(415);
    expect(h.r2.store.size).toBe(0);
  });

  it('refuses a file over the size limit (413), checked from content-length and from the real body', async () => {
    const h = makeHarness({ MAX_UPLOAD_BYTES: '100' });
    const { projectId, people } = await setup(h, { authors: ['a@example.com'] });
    const author = people['a@example.com']!;
    const big = new Uint8Array(101); big.set(samplePng());
    const declared = await author.upload(`/api/projects/${projectId}/images?title=x`, big);
    expect(declared.status).toBe(413);
    // lying about the length: declares 50 bytes, sends 101
    const liar = await author.req(`/api/projects/${projectId}/images?title=x`, { method: 'POST', headers: { 'content-length': '50' }, body: big });
    expect([413, 400, 500]).toContain(liar.status);
    expect(h.r2.store.size).toBe(0);
  });

  it('refuses an upload without content-length (411)', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { authors: ['a@example.com'] });
    const r = await people['a@example.com']!.req(`/api/projects/${projectId}/images?title=x`, { method: 'POST', headers: { 'content-length': '0' }, body: '' });
    expect(r.status).toBe(411);
  });

  it('refuses the same file twice on one image (409)', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { authors: ['a@example.com'] });
    const author = people['a@example.com']!;
    const bytes = samplePng(7);
    const first = await author.upload(`/api/projects/${projectId}/images?title=x`, bytes);
    const { image } = (await first.json()) as { image: string };
    const again = await author.upload(`/api/images/${image}/versions`, bytes);
    expect(again.status).toBe(409);
  });

  it('keeps pin coordinates inside the image', async () => {
    const h = makeHarness();
    const { projectId, people } = await setup(h, { reviewers: ['r1@example.com'], authors: ['a@example.com'] });
    const img = await firstImage(people['a@example.com']!, projectId);
    await people['r1@example.com']!.post(`/api/images/${img.image}/comments`, { x: 5, y: -3, body: 'edge' });
    const c = h.db.prepare('SELECT x, y FROM comments').get() as { x: number; y: number };
    expect(c).toEqual({ x: 1, y: 0 });
  });

  it('an admin who is not a member can upload an image and a new version; a reviewer still cannot', async () => {
    const h = makeHarness();
    const { admin, projectId, people } = await setup(h, { reviewers: ['r1@example.com'] });
    const first = await admin.upload(`/api/projects/${projectId}/images?title=From+admin`, samplePng());
    expect(first.status).toBe(201);
    const { image } = (await first.json()) as { image: string };
    const next = await admin.upload(`/api/images/${image}/versions`, samplePng());
    expect(next.status).toBe(201);
    const reviewer = people['r1@example.com']!;
    expect((await reviewer.upload(`/api/projects/${projectId}/images?title=x`, samplePng())).status).toBe(403);
    expect((await reviewer.upload(`/api/images/${image}/versions`, samplePng())).status).toBe(403);
  });
});
