CREATE TABLE pulls (
  repository_id TEXT NOT NULL,
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  rerun_sequence INTEGER NOT NULL DEFAULT 0 CHECK (rerun_sequence >= 0),
  blocked_reason TEXT,
  observed_head_sha TEXT,
  observed_base_ref TEXT,
  current_attempt_id INTEGER REFERENCES attempts(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, pull_number)
) STRICT;

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  work_key TEXT NOT NULL,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  terminal_state TEXT CHECK (terminal_state IN ('complete', 'incomplete', 'intervention')),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  recovery_started_at INTEGER,
  last_work_at INTEGER NOT NULL DEFAULT 0,
  intervention_reason TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  lease_losses INTEGER NOT NULL DEFAULT 0,
  progress_sequence INTEGER NOT NULL DEFAULT 0,
  UNIQUE (repository_id, pull_number, generation),
  FOREIGN KEY (repository_id, pull_number) REFERENCES pulls(repository_id, pull_number),
  CHECK ((state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state != 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL))
) STRICT;

CREATE TABLE pass_executions (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  pass_id TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (attempt_id, pass_id)
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

CREATE TABLE webhook_receipts (
  id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE access_rules (
  installation_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  PRIMARY KEY (installation_id, repository_id)
) STRICT;
CREATE TABLE access_clock (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
INSERT INTO access_clock VALUES (1, 0);

CREATE TABLE publication_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL, pull_number INTEGER NOT NULL,
  notice_json TEXT NOT NULL CHECK(json_valid(notice_json)),
  FOREIGN KEY(repository_id, pull_number) REFERENCES pulls(repository_id, pull_number)
) STRICT;
CREATE TABLE publication_operations (
  operation_key TEXT PRIMARY KEY, repository_id TEXT NOT NULL, pull_number INTEGER NOT NULL,
  operation_json TEXT NOT NULL CHECK(json_valid(operation_json)),
  FOREIGN KEY(repository_id, pull_number) REFERENCES pulls(repository_id, pull_number)
) STRICT;
PRAGMA user_version = 4;
