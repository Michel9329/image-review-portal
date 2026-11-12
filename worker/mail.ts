/** Login emails through Resend. Without RESEND_API_KEY no email is sent; the code is printed in the Worker log only when DEV_MODE=1 (local use). */
import type { Env } from './types';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);

export function loginMail(appName: string, code: string, link: string) {
  const subject = `Your ${appName} sign-in code`;
  const text = `Your sign-in code: ${code}\n\nType it in the page you already have open.\nOr open this link (valid 90 minutes):\n${link}\n\nIf you did not ask for this, ignore this email.`;
  const html = `<p>Your sign-in code:</p><p style="font:700 28px/1.2 monospace;letter-spacing:.2em">${esc(code)}</p>`
    + `<p>Type it in the page you already have open, or <a href="${esc(link)}">open this link</a> (valid 90 minutes).</p>`
    + '<p style="color:#666">If you did not ask for this, ignore this email.</p>';
  return { subject, text, html };
}

export async function sendMail(env: Env, to: string, mail: { subject: string; text: string; html: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    return r.ok;
  } catch (e) {
    console.log('[irp] mail failed:', (e as Error).message);
    return false;
  }
}
