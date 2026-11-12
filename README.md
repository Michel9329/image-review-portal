# Image Review Portal

[![test](https://github.com/Michel9329/image-review-portal/actions/workflows/test.yml/badge.svg)](https://github.com/Michel9329/image-review-portal/actions/workflows/test.yml)

A small web app for getting images approved. People you invite open a project, pin comments on a point of an image, compare versions, and approve the current version. An image counts as approved when a number of reviewers you choose (N) have signed it.

It runs on Cloudflare: one Worker, one D1 database, one private R2 bucket, one KV namespace. There is no build step and no front end framework.

Built with Claude Code, designed and reviewed by Michel Dimitri.

## Who it is for

Anyone who has to get images approved by a client or a business partner and is tired of corrections arriving by chat: designers, photographers, agencies, small studios. You upload, they point at the exact spot that needs a change and write why, you upload a new version, and they sign the one they have seen.

## What it does

- **Projects with their own access list.** Only the people added to a project can see it. Anyone else gets a 404.
- **Two roles per project.** `reviewer`: pins comments, resolves them, approves. `author`: uploads images and new versions, replies, marks comments as addressed. A global admin (set by email in config) creates projects, manages members and can also upload images and new versions without being added as an author.
- **Comments pinned to a point.** Click the image, a numbered pin appears at that spot, the thread stays attached to the version it was written on. A comment can also be left without a pin.
- **Versions.** Upload a new file for the same image. Old versions stay viewable. A comment keeps pointing at the version it was written on.
- **Approval with N signatures.** Each project sets how many reviewers must sign (1 to 20). Signatures are tied to the version the reviewer was looking at. Uploading a new version resets the count. If a newer version arrives while someone is about to sign, the signature is refused (409) so nobody approves something they have not seen.
- **Derived status.** `awaiting approval`, `partly approved`, `approved`, `changes requested` (open comments), `fix to review` (the author says a comment is addressed). The status is computed from the data, never stored.
- **Append-only approvals.** Withdrawing a signature marks the row as revoked; nothing is deleted. Each row freezes the reviewer's email and the SHA-256 of the file.
- **Sign-in by email code.** A six digit code typed in the open browser, plus a link as a fallback. No passwords.

Not included: side-by-side before/after slider, email notifications about comments, image attachments inside comments, editing or deleting a message, i18n (the interface is in English only).

## Run it locally

Requires Node 22.13 or newer: the tests use the built-in `node:sqlite` module.

```bash
npm install
cp .dev.vars.example .dev.vars          # then set SESSION_SECRET
npm run db:init:local                    # creates the tables in a local D1
npm run dev                              # http://localhost:8787
```

Open the page and sign in with the address in `ADMIN_EMAILS` (`wrangler.jsonc`, default `admin@example.com`; change it first). Without `RESEND_API_KEY` the six digit code is printed in the terminal that runs `wrangler dev`, because `.dev.vars.example` sets `DEV_MODE=1`.

Both `db:init:local` and `dev` store their data in `.wrangler/state` (`--persist-to`), so they always use the same local database. This was tried from a clean copy with the placeholder ids in `wrangler.jsonc` unchanged, in this order: `npm run db:init:local`, then `npm run dev`, then sign in as the admin with the code printed in the terminal. It worked with the Wrangler version in `package-lock.json`. If your Wrangler refuses the `REPLACE_WITH_...` ids even in local mode, put valid-looking ones in temporarily (32 hex zeros for KV, a UUID of zeros for D1) and change them back before you deploy. To start over, delete the `.wrangler/state` folder and run `npm run db:init:local` again.

## Deploy, step by step

1. `npm install` and log in: `npx wrangler login`.
2. Create the database: `npx wrangler d1 create image-review-portal`. Copy the `database_id` it prints into `wrangler.jsonc`.
3. Create the bucket: `npx wrangler r2 bucket create image-review-portal-media`. Keep it private: do not enable a public `r2.dev` URL.
4. Create the KV namespace: `npx wrangler kv namespace create RATE_LIMIT`. Copy the `id` into `wrangler.jsonc`.

   In steps 2 to 4 Wrangler may offer to add the snippet to your config for you. Answer no: the bindings must keep the names `DB`, `MEDIA` and `RATE_LIMIT`, and you only paste the ids.

5. In `wrangler.jsonc` set `ADMIN_EMAILS` (the people who can create projects), `APP_NAME`, and optionally `APP_URL` and `MAIL_FROM`.
6. Create the tables: `npm run db:init`.
7. Set the secrets. Before the first deploy Wrangler asks whether to create the Worker: answer yes, step 8 fills it in.
   - `npx wrangler secret put SESSION_SECRET` (random, at least 32 characters; the Worker refuses to run with a shorter one).
   - `npx wrangler secret put RESEND_API_KEY` (optional; needed to email the sign-in codes; `MAIL_FROM` must be on a domain verified in Resend. Without it nobody receives a code: production never prints codes, and `DEV_MODE` must stay unset there).
8. `npm run deploy`. Optionally add a `routes` entry with your own domain (there is a commented example in `wrangler.jsonc`).
9. Open the URL, sign in as an admin and create a project. Add people by email with the role `reviewer` or `author`; to sign images yourself, add your own email as `reviewer` too (admins can comment and upload, only reviewers sign). Only invited emails (and admins) can request a code. Open comments keep an image in "changes requested" until they are resolved, even after the signatures.

### Remove everything

To uninstall: `npx wrangler delete`, then `npx wrangler d1 delete image-review-portal`, `npx wrangler kv namespace delete --namespace-id <id>` and `npx wrangler r2 bucket delete image-review-portal-media`. A bucket must be empty before it can be deleted: remove its objects first with `npx wrangler r2 object delete image-review-portal-media/<key>` or from the Cloudflare dashboard.

## Tests

```bash
npm test          # vitest: 35 tests
npm run typecheck
```

The tests run the real Hono app against an in-memory SQLite database wrapped to look like D1, with fake R2 and KV. They cover approval with N signatures (including reset on new version, stale-version refusal, duplicate and revoked signatures), access denied for people outside a project and for the wrong role on every route that touches a project, CSRF, sign-in codes, and upload checks (non-images, SVG, size limit, duplicates). They do not talk to Cloudflare, so a deploy still deserves a manual pass.

## Security

- **Access is checked per project on every route** that reads or writes a project, image, version, comment or file (`accessTo` and `imageWithAccess` in `worker/logic.ts`). Non-members get 404 so ids cannot be probed; members with the wrong role get 403.
- **Uploads:** images only (PNG, JPEG, WebP, GIF), identified from the file bytes, not from the declared type. SVG and PDF are refused. A `Content-Length` is required and checked against `MAX_UPLOAD_BYTES` (default 10 MB), and the real body length is checked again.
- **Files are private.** Served only through the Worker after the access check, with `nosniff`, `noindex` and `Cache-Control: private`.
- **Sessions:** HMAC signed, `HttpOnly`, `Secure`, `SameSite=Lax`, 90 days. Writes need a CSRF header that matches a cookie.
- **Sign-in:** the answer to "send me a code" is identical, in content and timing, whether or not the email is known. Codes expire after 90 minutes and lock after five wrong tries. Rate limits on codes, attempts, uploads and writes (Workers KV, fixed window, per IP; it is not exact under bursts).
- **Headers:** strict Content Security Policy (no inline script, no other origins), `X-Frame-Options: DENY`, HSTS.
- The front end builds its DOM with `textContent`, never `innerHTML`.
- Admin status comes from `ADMIN_EMAILS`. Anyone who controls an inbox in that list can create projects and add members.

Not covered: malware scanning of uploads, audit log screens (events are written to the `events` table but there is no page for them), per-user data export or deletion. If you handle personal data in images, those are yours to add.

## Known limits

- A sign-in link works for whoever opens it. Someone could send you their own link and sign you into their account (a property of all email sign-in links); the code typed in the open browser avoids this.
- **D1 free plan and rows read.** On the Workers Free plan D1 allows 5 million rows read per day for the whole account, not per database. When it is exceeded Cloudflare does not fail cleanly: some reads are refused and others pass, so the app breaks at random until midnight UTC, and even sign-in fails because the session check reads the database. This was learned the hard way on the portal this one is derived from: one gallery page ran four sub-queries per image against a table with a missing index and burned the quota in a day. What this repository does about it:
  - queries use grouped CTEs, no per-row sub-queries (see the project page query in `worker/index.ts`);
  - every table has the index its queries filter on (`schema.sql`);
  - `worker/d1-retry.ts` retries a read up to four times, only for that specific error.

  It does not raise the limit. Measure with `npx wrangler d1 info image-review-portal` (look at `rows_read_24h`), and after any migration that recreates a table, re-read `sqlite_master` to check the indexes are still there. If several apps share the account, they share the 5 million. Workers Paid ($5 a month at the time of writing) removes the problem.
- Files are read into memory on upload (limit 10 MB by default). Do not raise the limit far above that without moving to streamed or presigned uploads.
- KV rate limits are approximate.
- No email notifications about comments or approvals; only sign-in emails.
- The access list is per project and managed by admins only.

## Layout

```
worker/index.ts      routes, sign-in, uploads
worker/logic.ts      access rules, comments, approvals, derived status
worker/auth.ts       signed cookies, CSRF, login codes
worker/upload-guard.ts, media.ts, rate-limit.ts, d1-retry.ts, mail.ts
schema.sql           D1 tables and indexes
public/              single page front end (plain JS, no build)
test/                vitest suites and the D1/R2/KV test doubles
```

## License

MIT. See `LICENSE`.

---

More tools from the same system: [github.com/Michel9329](https://github.com/Michel9329).
