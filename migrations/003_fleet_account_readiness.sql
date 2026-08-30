CREATE TABLE IF NOT EXISTS tah_script_account_activity (
  shard_id text NOT NULL REFERENCES tah_script_shards(shard_id) ON DELETE CASCADE,
  customer_id text NOT NULL CHECK (customer_id ~ '^\d{10}$'),
  manifest_seen_at timestamptz,
  last_poll_at timestamptz,
  worker_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shard_id, customer_id)
);

CREATE INDEX IF NOT EXISTS tah_script_account_activity_poll_idx
  ON tah_script_account_activity (shard_id, last_poll_at DESC);

COMMENT ON TABLE tah_script_account_activity IS
  'Per-customer Fleet worker readiness. Manifest sightings and customer-scoped polls gate only a target''s first browser journey.';
