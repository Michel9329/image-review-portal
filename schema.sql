-- Image Review Portal: D1 schema. Safe to run more than once (IF NOT EXISTS everywhere).
-- D1 does not enable PRAGMA foreign_keys, so referential integrity is enforced by the Worker.
-- Rule: every query stays well under 1,000 rows read. No per-row sub-queries; counts use
-- grouped CTEs. See "Known limits" in the README (D1 free plan read limit).

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  session_from INTEGER,                 -- sessions issued before this epoch are rejected
  last_seen    INTEGER,
  created      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One-time login: a six digit code typed in the open browser, plus a link as a fallback.
CREATE TABLE IF NOT EXISTS login_codes (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires    INTEGER NOT NULL,
  used       INTEGER,
  link_used  INTEGER,
  created    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes(email, created);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  required_approvals INTEGER NOT NULL DEFAULT 1,   -- N signatures needed on the current version
  created_by         TEXT,
  created            INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Access is per project. role: reviewer (comments, approves) | author (uploads, replies).
CREATE TABLE IF NOT EXISTS members (
  project_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  added      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS images (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  title           TEXT NOT NULL,
  current_version TEXT,
  created         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS images_project ON images(project_id, created);

-- One row per uploaded file. R2 keys contain the version id, so they are immutable.
CREATE TABLE IF NOT EXISTS versions (
  id       TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  number   INTEGER NOT NULL,
  filename TEXT NOT NULL,
  sha256   TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  mime     TEXT NOT NULL,
  r2_key   TEXT NOT NULL,
  note     TEXT,                         -- what changed, written by the uploader
  author   TEXT,
  created  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (image_id, number),
  UNIQUE (image_id, sha256)
);
CREATE INDEX IF NOT EXISTS versions_image ON versions(image_id, number);

-- A comment thread, optionally pinned to a point (x, y between 0 and 1) of one version.
-- status: open | addressed (the author uploaded a fix) | resolved
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  image_id   TEXT NOT NULL,
  version_id TEXT NOT NULL,
  number     INTEGER NOT NULL,           -- the number shown on the pin, per image
  x          REAL,
  y          REAL,
  status     TEXT NOT NULL DEFAULT 'open',
  author     TEXT NOT NULL,
  created    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (image_id, number)
);
CREATE INDEX IF NOT EXISTS comments_image ON comments(image_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS messages_comment ON messages(comment_id, created);

-- Append-only: revoking writes `revoked`, never DELETE. Each row pins the VERSION the reviewer
-- had in front of them and freezes the email and file hash, so the proof does not depend on
-- tables that change later.
CREATE TABLE IF NOT EXISTS approvals (
  id         TEXT PRIMARY KEY,
  image_id   TEXT NOT NULL,
  version_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  created    INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_live ON approvals(version_id, user_id) WHERE revoked IS NULL;
CREATE INDEX IF NOT EXISTS approvals_image ON approvals(image_id, revoked);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  image_id   TEXT,
  type       TEXT NOT NULL,
  user_id    TEXT,
  data       TEXT,
  created    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, created);
