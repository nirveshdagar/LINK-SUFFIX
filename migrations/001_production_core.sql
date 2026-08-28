CREATE TABLE IF NOT EXISTS tah_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tah_campaign_targets (
  target_id text PRIMARY KEY,
  campaign_record_id text NOT NULL UNIQUE,
  campaign_name text NOT NULL,
  manager_customer_id text NOT NULL DEFAULT '',
  customer_id text NOT NULL,
  google_campaign_id text NOT NULL,
  shard_id text NOT NULL DEFAULT 'default',
  enabled boolean NOT NULL DEFAULT true,
  min_delivery_interval_ms integer NOT NULL DEFAULT 58000 CHECK (min_delivery_interval_ms >= 58000),
  last_applied_at timestamptz,
  last_applied_suffix_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manager_customer_id, customer_id, google_campaign_id)
);

CREATE TABLE IF NOT EXISTS tah_suffix_captures (
  capture_id bigserial PRIMARY KEY,
  target_id text NOT NULL REFERENCES tah_campaign_targets(target_id) ON DELETE CASCADE,
  version bigint NOT NULL,
  exact_suffix text NOT NULL,
  suffix_hash text NOT NULL,
  source_run_id text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, version)
);

CREATE TABLE IF NOT EXISTS tah_delivery_jobs (
  job_id text PRIMARY KEY,
  target_id text NOT NULL REFERENCES tah_campaign_targets(target_id) ON DELETE CASCADE,
  capture_id bigint NOT NULL REFERENCES tah_suffix_captures(capture_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','applied','failed','dead','superseded')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_at timestamptz,
  leased_until timestamptz,
  lease_token_hash text,
  worker_id text,
  applied_at timestamptz,
  verified_suffix_hash text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, capture_id)
);

CREATE INDEX IF NOT EXISTS tah_delivery_jobs_ready_idx
  ON tah_delivery_jobs (state, available_at, created_at)
  WHERE state IN ('pending','failed');
CREATE INDEX IF NOT EXISTS tah_delivery_jobs_target_idx ON tah_delivery_jobs (target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tah_suffix_captures_target_idx ON tah_suffix_captures (target_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS tah_script_shards (
  shard_id text PRIMARY KEY,
  token_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_poll_at timestamptz,
  last_ack_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tah_leader_leases (
  lease_name text PRIMARY KEY,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tah_audit_log (
  audit_id bigserial PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tah_audit_log_created_idx ON tah_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS tah_audit_log_resource_idx ON tah_audit_log (resource_type, resource_id, created_at DESC);

ALTER TABLE IF EXISTS tah_control_state ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS tah_control_state ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 0;
