/**
 * Serves files from R2. The bytes are streamed (`object.body`), never buffered with
 * .arrayBuffer(): a Worker isolate has 128 MB of memory.
 */
import type { Env } from './types';

export function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[\\"\r\n\t\x00-\x1f\x7f]/g, '').replace(/[^\x20-\x7e]/g, '_').slice(0, 200) || 'file';
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function serveFromR2(env: Env, key: string, req: Request,
  opt: { filename: string; inline: boolean; etag?: string }): Promise<Response> {
  const etag = opt.etag ? `"${opt.etag}"` : undefined;
  if (etag && req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'private, max-age=31536000, immutable' } });
  }
  const object = await env.MEDIA.get(key);
  if (!object) return new Response('not found', { status: 404 });
  const h = new Headers();
  object.writeHttpMetadata(h);
  h.set('content-disposition', contentDisposition(opt.filename, opt.inline));
  h.set('x-content-type-options', 'nosniff');
  h.set('x-robots-tag', 'noindex, nofollow');
  // Versions are immutable (the key contains the version id), but the file is private:
  // browsers may keep it, shared caches may not.
  h.set('cache-control', 'private, max-age=31536000, immutable');
  if (etag) h.set('etag', etag);
  return new Response(object.body, { status: 200, headers: h });
}
