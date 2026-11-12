/**
 * Upload checks. Images only, confirmed from the real bytes: the Content-Type sent by the client
 * is not trusted. SVG and PDF are refused on purpose (SVG can carry scripts).
 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export const DEFAULT_MAX_UPLOAD = 10 * 1024 * 1024;

export function maxUpload(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_UPLOAD;
}

/** Returns the MIME type from the file signature, or null if it is not a supported image. */
export function detectImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

const EXT: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const extensionFor = (m: ImageMime) => EXT[m];
