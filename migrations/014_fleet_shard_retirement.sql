-- A retained tombstone prevents old worker tokens from re-importing a deleted shard.
SET LOCAL lock_timeout = '5s';
ALTER TABLE tah_script_shards ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Preserve the originating shard when a campaign moves during a delivery lease.
-- v12 already has this column; v11 records it without changing its lease contract.
ALTER TABLE tah_delivery_jobs ADD COLUMN IF NOT EXISTS lease_shard_id text;
UPDATE tah_delivery_jobs j SET lease_shard_id=t.shard_id
FROM tah_campaign_targets t
WHERE j.target_id=t.target_id AND j.state='leased' AND j.lease_shard_id IS NULL;
