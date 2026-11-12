/**
 * Fixed-window rate limits on Workers KV. Key = `rl:<rule>:<key>`, value = { count, resetAt }.
 * KV is eventually consistent, so two simultaneous requests can both read the same count; that is
 * fine for the small limits used here. Fails open if KV errors.
 */
import type { Context } from 'hono';

interface State { count: number; resetAt: number }

export interface RateLimitResult { allowed: boolean; remaining: number; resetAt: number; retryAfter: number }

export function clientIp(c: Context): string | null {
  // CF-Connecting-IP is set by the Cloudflare edge and cannot be forged by the client.
  // X-Forwarded-For is deliberately not used.
  const cf = c.req.header('CF-Connecting-IP');
  return cf ? cf.trim() : null;
}

function parse(raw: string | null, now: number): State | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<State>;
    if (typeof p.count === 'number' && typeof p.resetAt === 'number' && p.resetAt > now) return { count: p.count, resetAt: p.resetAt };
  } catch { /* corrupt value: start a new window */ }
  return null;
}

export async function consumeRateLimit(kv: KVNamespace, rule: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const full = `rl:${rule}:${key}`;
  const now = Math.floor(Date.now() / 1000);
  const stored = parse(await kv.get(full), now);
  const count = stored ? stored.count : 0;
  const resetAt = stored ? stored.resetAt : now + windowSeconds;
  if (count >= limit) return { allowed: false, remaining: 0, resetAt, retryAfter: Math.max(1, resetAt - now) };
  try {
    await kv.put(full, JSON.stringify({ count: count + 1, resetAt }), { expirationTtl: Math.max(60, windowSeconds + 5) });
  } catch (e) {
    console.log('[irp] rate-limit put failed:', (e as Error).message);
  }
  return { allowed: true, remaining: Math.max(0, limit - count - 1), resetAt, retryAfter: 0 };
}

export function applyRateLimit(c: Context, r: RateLimitResult, limit: number, message = 'too_many_requests'): Response | undefined {
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    c.header('Retry-After', String(r.retryAfter));
    return c.json({ error: message }, 429);
  }
  return undefined;
}
