export interface Env {
  DB: D1Database;
  /** Static front end (the public/ folder). */
  ASSETS: Fetcher;
  /** Private R2 bucket. No public domain: every file goes through the authenticated Worker. */
  MEDIA: R2Bucket;
  /** KV namespace for rate limits. */
  RATE_LIMIT: KVNamespace;

  /** Signs sessions. Set with `wrangler secret put SESSION_SECRET` (at least 32 characters). */
  SESSION_SECRET: string;
  /** Optional. Without it no email is sent; login codes are printed in the Worker log only when DEV_MODE=1 (local use). */
  RESEND_API_KEY?: string;
  /** "1" only on a local or test instance: prints sign-in codes to the log when no mail is sent. */
  DEV_MODE?: string;
  /** Sender address on a domain verified in Resend. */
  MAIL_FROM?: string;
  /** Comma separated emails that can create projects and manage members. */
  ADMIN_EMAILS?: string;
  /** Public URL of the app, used in login links. */
  APP_URL?: string;
  /** Display name of the app in emails. */
  APP_NAME?: string;
  /** Upload limit in bytes. Default 10 MB. */
  MAX_UPLOAD_BYTES?: string;
}

export type Role = 'reviewer' | 'author';

export interface User {
  id: string;
  email: string;
  name: string | null;
  session_from: number | null;
}

/** What a user can do on one project. `admin` is a global flag, not a membership. */
export interface Access {
  project_id: string;
  role: Role | null;
  admin: boolean;
}
