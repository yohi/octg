CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE client_policies (
  client_id TEXT PRIMARY KEY REFERENCES clients(id),
  overflow_mode TEXT NOT NULL DEFAULT 'REJECT',
  output_limit_mode TEXT NOT NULL DEFAULT 'REJECT',
  max_paid_usd_day REAL NOT NULL DEFAULT 0,
  cache_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE model_registry (
  model TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  complimentary_pool TEXT NOT NULL DEFAULT 'NONE',
  enabled INTEGER NOT NULL DEFAULT 1,
  fallback_model TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL,
  client_id TEXT NOT NULL,
  requested_model TEXT,
  upstream_model TEXT,
  pool TEXT,
  eligibility TEXT,
  reserved_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  status TEXT NOT NULL,
  billing_class TEXT,
  openai_request_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_requests_day_pool ON requests (utc_day, pool, status);
CREATE INDEX idx_requests_client ON requests (client_id, utc_day);

CREATE TABLE daily_usage (
  utc_day TEXT NOT NULL,
  pool TEXT NOT NULL,
  confirmed_tokens INTEGER NOT NULL DEFAULT 0,
  paid_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (utc_day, pool)
);

CREATE TABLE reconciliations (
  utc_day TEXT NOT NULL,
  pool TEXT NOT NULL,
  local_tokens INTEGER NOT NULL,
  openai_tokens INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  attempts INTEGER NOT NULL DEFAULT 0,
  executed_at TEXT NOT NULL,
  PRIMARY KEY (utc_day, pool)
);
