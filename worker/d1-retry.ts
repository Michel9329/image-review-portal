/**
 * D1 wrapper that retries reads rejected by the free plan daily row-read limit.
 *
 * On the Workers Free plan D1 allows 5 million rows READ per day per account. Past that, Cloudflare
 * starts refusing reads, not always all of them: the app then fails at random. This wrapper
 * repeats the same statement up to four times, with short pauses, only for that specific error.
 * Any other error passes straight through. It hides nothing: if the refusal persists, the error
 * reaches the caller. It does NOT raise the limit. See "Known limits" in the README.
 */
const MARK = Symbol.for('irp.d1-retry');
const ATTEMPTS = 4;
const WAITS_MS = [120, 300, 700];

export function isReadLimitError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e ?? '');
  return text.includes('row read limit');
}

export async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < ATTEMPTS; i++) {
    try { return await fn(); } catch (e) {
      if (!isReadLimitError(e)) throw e;
      last = e;
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, WAITS_MS[i] ?? 700));
    }
  }
  throw last;
}

const originals = new WeakMap<object, D1PreparedStatement>();

function wrapStatement(s: D1PreparedStatement): D1PreparedStatement {
  const proxy = new Proxy(s, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'bind') return (...args: unknown[]) => wrapStatement((target.bind as (...a: unknown[]) => D1PreparedStatement)(...args));
      if (prop === 'all' || prop === 'first' || prop === 'run' || prop === 'raw') {
        return (...args: unknown[]) => retry(() => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  originals.set(proxy, s);
  return proxy;
}

export function withRetry(db: D1Database): D1Database {
  if ((db as unknown as Record<symbol, unknown>)[MARK]) return db;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === MARK) return true;
      const v = Reflect.get(target, prop, receiver);
      if (prop === 'prepare') return (sql: string) => wrapStatement(target.prepare(sql));
      if (prop === 'batch') return (stmts: D1PreparedStatement[]) => retry(() => target.batch(stmts.map((s) => originals.get(s) ?? s)));
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
