/**
 * Authentication: HMAC signed session cookies, a CSRF double-submit cookie, and
 * one-time login codes (six digits typed in the open browser, plus a link).
 */
import type { Env, User } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

/** Constant time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(payload: object, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  return body + '.' + b64urlEncode(await hmac(secret, body));
}

async function verify<T>(token: string, secret: string): Promise<T | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), b64urlEncode(await hmac(secret, body)))) return null;
  try { return JSON.parse(dec.decode(b64urlDecode(body))) as T; } catch { return null; }
}

export async function sha256hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

export function newId(prefix: string): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return prefix + '_' + b64urlEncode(bytes);
}

/** Uniform six digit code (rejection sampling, so low digits are not favoured). */
export function generateCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do { crypto.getRandomValues(buf); n = buf[0] as number; } while (n >= 4_294_000_000);
  return String(n % 1_000_000).padStart(6, '0');
}

const SESSION_DAYS = 90;
export const SESSION_COOKIE = 'irp_session';
export const CSRF_COOKIE = 'irp_csrf';

export interface Session { uid: string; born: number; exp: number }

export async function sessionCookie(u: User, env: Env): Promise<string> {
  const s: Session = { uid: u.id, born: Date.now(), exp: Date.now() + SESSION_DAYS * 86400_000 };
  return [`${SESSION_COOKIE}=` + await sign(s, env.SESSION_SECRET), 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax',
    'Max-Age=' + SESSION_DAYS * 86400].join('; ');
}

export function csrfCookie(): string {
  return [`${CSRF_COOKIE}=` + randomToken(), 'Path=/', 'Secure', 'SameSite=Strict', 'Max-Age=' + SESSION_DAYS * 86400].join('; ');
}

export const clearedCookies = [
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  `${CSRF_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`,
];

export async function readSession(cookie: string | undefined, env: Env): Promise<Session | null> {
  const m = (cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const s = await verify<Session>(m[1] as string, env.SESSION_SECRET);
  return s && typeof s.exp === 'number' && s.exp > Date.now() ? s : null;
}
