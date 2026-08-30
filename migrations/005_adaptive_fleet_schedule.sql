ALTER TABLE tah_script_shards
  ADD COLUMN IF NOT EXISTS last_execution_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_execution_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_execution_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_invocation_id text,
  ADD COLUMN IF NOT EXISTS last_execution_status text,
  ADD COLUMN IF NOT EXISTS schedule_anchor_at timestamptz,
  ADD COLUMN IF NOT EXISTS schedule_sample_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expected_next_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS phase_one_stop_at timestamptz,
  ADD COLUMN IF NOT EXISTS hard_stop_at timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_margin_ms integer NOT NULL DEFAULT 120000;

CREATE INDEX IF NOT EXISTS tah_script_shards_expected_start_idx
  ON tah_script_shards (expected_next_start_at)
  WHERE enabled;

COMMENT ON COLUMN tah_script_shards.schedule_anchor_at IS
  'Learned Google Ads Scripts hourly trigger phase used to shorten off-cycle executions.';

COMMENT ON COLUMN tah_script_shards.hard_stop_at IS
  'Server-owned execution deadline, normally two minutes before the next expected Google trigger.';
