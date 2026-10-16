CREATE TABLE pulls (
  repository_id TEXT NOT NULL,
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  current_attempt_id INTEGER REFERENCES attempts(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, pull_number)
) STRICT;

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  work_key TEXT NOT NULL UNIQUE,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  UNIQUE (repository_id, pull_number, generation),
  FOREIGN KEY (repository_id, pull_number) REFERENCES pulls(repository_id, pull_number),
  CHECK ((state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state != 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL))
) STRICT;

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  received_at INTEGER NOT NULL,
  trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json))
) STRICT;

CREATE TABLE passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  pass_id TEXT NOT NULL,
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (attempt_id, pass_id)
) STRICT;

CREATE TABLE publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  publication_key TEXT NOT NULL,
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  state TEXT NOT NULL CHECK (state IN ('planned', 'superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (attempt_id, publication_key)
) STRICT;

PRAGMA user_version = 1;
