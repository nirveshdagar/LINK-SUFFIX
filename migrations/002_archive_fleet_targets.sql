ALTER TABLE tah_campaign_targets
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS tah_campaign_targets_active_shard_idx
  ON tah_campaign_targets(shard_id, updated_at DESC)
  WHERE enabled = TRUE AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS tah_campaign_targets_archived_at_idx
  ON tah_campaign_targets(archived_at DESC)
  WHERE archived_at IS NOT NULL;

COMMENT ON COLUMN tah_campaign_targets.archived_at IS
  'Soft-removal timestamp. Archived Fleet targets retain captures, jobs, and audit history.';
