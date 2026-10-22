CREATE TABLE IF NOT EXISTS bundles (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  manifest TEXT NOT NULL,
  checksum TEXT NOT NULL,
  review TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('public', 'private')),
  passcode_digest TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS bundles_owner_created_idx ON bundles(owner_id, created_at);
