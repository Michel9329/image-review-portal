/**
 * Test harness. Runs the real Hono app against:
 *  - an in-memory SQLite database (node:sqlite) wrapped to look like D1,
 *  - a Map standing in for R2 and for the KV rate-limit namespace.
 * Nothing here touches Cloudflare.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from '../worker/index';
import type { Env } from '../worker/types';

// Loaded through require: Vite does not know the node:sqlite builtin yet.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

class Stmt {
  constructor(private db: DatabaseSync, readonly sql: string, private params: unknown[] = []) {}
  bind(...p: unknown[]) { return new Stmt(this.db, this.sql, p); }
  private prep() { return this.db.prepare(this.sql); }
  async first<T = unknown>(): Promise<T | null> { return ((this.prep().get(...(this.params as any[])) as T) ?? null); }
  async all<T = unknown>() { return { results: this.prep().all(...(this.params as any[])) as T[], success: true, meta: {} }; }
  async run() { const r = this.prep().run(...(this.params as any[])); return { success: true, meta: { changes: Number(r.changes) } }; }
  exec() { return this.prep().run(...(this.params as any[])); }
}

export function fakeD1(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) {
          const isRead = /^\s*(select|with)/i.test(s.sql);
          out.push(isRead ? await s.all() : await s.run());
        }
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  } as unknown as D1Database;
}

export function fakeR2() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: async (key: string, value: Uint8Array) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    get: async (key: string) => {
      const bytes = store.get(key);
      if (!bytes) return null;
      return { body: new Response(bytes).body, writeHttpMetadata: (h: Headers) => h.set('content-type', 'image/png') };
    },
  } as unknown as R2Bucket;
}

export function fakeKV() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); } } as unknown as KVNamespace;
}

export interface Harness {
  env: Env;
  db: DatabaseSync;
  r2: R2Bucket & { store: Map<string, Uint8Array> };
  call(path: string, init?: RequestInit): Promise<Response>;
}

export function makeHarness(overrides: Partial<Env> = {}): Harness {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8'));
  const r2 = fakeR2() as R2Bucket & { store: Map<string, Uint8Array> };
  const env: Env = {
    DB: fakeD1(db), MEDIA: r2, RATE_LIMIT: fakeKV(),
    ASSETS: { fetch: async () => new Response('spa', { status: 200 }) } as unknown as Fetcher,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123456',
    ADMIN_EMAILS: 'admin@example.com',
    ...overrides,
  };
  const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return { env, db, r2, call: (path, init) => Promise.resolve(app.request(path, init, env, ctx)) };
}

/** A signed-in person: cookie jar plus helpers that add the CSRF header. */
export class Client {
  cookie = '';
  csrf = '';
  constructor(private h: Harness, readonly email: string) {}

  async login() {
    await this.h.call('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email }) });
    const row = this.h.db.prepare('SELECT code FROM login_codes WHERE email = ? ORDER BY created DESC, rowid DESC LIMIT 1').get(this.email) as { code: string } | undefined;
    if (!row) throw new Error('no code was issued for ' + this.email);
    const res = await this.h.call('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: this.email, code: row.code }) });
    if (res.status !== 200) throw new Error('login failed ' + res.status);
    const jar = res.headers.getSetCookie().map((c) => c.split(';')[0] as string);
    this.cookie = jar.join('; ');
    this.csrf = (jar.find((c) => c.startsWith('irp_csrf=')) || '').split('=')[1] || '';
    return this;
  }

  req(path: string, init: RequestInit & { csrf?: boolean } = {}) {
    const { csrf = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    if (csrf && this.csrf) headers.set('x-csrf-token', this.csrf);
    return this.h.call(path, { ...rest, headers });
  }

  get(path: string) { return this.req(path); }
  post(path: string, body: unknown = {}) {
    return this.req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  upload(path: string, bytes: Uint8Array, filename = 'sample.png') {
    return this.req(path, { method: 'POST', headers: { 'content-length': String(bytes.length), 'x-filename': filename }, body: bytes });
  }
}

let counter = 0;
/** A tiny valid PNG signature plus unique trailing bytes, so every call gives a different file hash. */
export function samplePng(extra = ++counter): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52];
  return new Uint8Array([...head, extra & 255, (extra >> 8) & 255, 1, 2, 3]);
}

/** A project with the given people, built through the real API. Returns ids and signed-in clients. */
export async function setup(h: Harness, opts: { required?: number; reviewers?: string[]; authors?: string[] } = {}) {
  const admin = await new Client(h, 'admin@example.com').login();
  const created = await admin.post('/api/projects', { name: 'Sample project', required_approvals: opts.required ?? 1 });
  const { id: projectId } = (await created.json()) as { id: string };
  const people: Record<string, Client> = {};
  for (const [emails, role] of [[opts.reviewers ?? [], 'reviewer'], [opts.authors ?? [], 'author']] as const) {
    for (const email of emails) {
      const r = await admin.post(`/api/projects/${projectId}/members`, { email, role });
      if (r.status !== 201) throw new Error('could not add ' + email);
      people[email] = await new Client(h, email).login();
    }
  }
  return { admin, projectId, people };
}

/** The first image of a project, uploaded by the given author. */
export async function firstImage(author: Client, projectId: string) {
  const r = await author.upload(`/api/projects/${projectId}/images?title=${encodeURIComponent('Sample 1')}`, samplePng());
  if (r.status !== 201) throw new Error('upload failed ' + r.status + ' ' + (await r.text()));
  return (await r.json()) as { image: string; version: string };
}
