BEGIN;

CREATE TABLE IF NOT EXISTS tah_health_alerts (
  fingerprint TEXT PRIMARY KEY,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('observing', 'active', 'acknowledged', 'resolved')),
  component TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'system',
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  remediation TEXT NOT NULL DEFAULT '',
  campaign_record_id TEXT,
  shard_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  activation_after_ms INTEGER NOT NULL DEFAULT 0,
  occurrence_count BIGINT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tah_health_alerts_open_idx
  ON tah_health_alerts (severity, status, last_seen_at DESC)
  WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS tah_health_alerts_campaign_idx
  ON tah_health_alerts (campaign_record_id, last_seen_at DESC)
  WHERE campaign_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tah_health_alerts_shard_idx
  ON tah_health_alerts (shard_id, last_seen_at DESC)
  WHERE shard_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tah_component_heartbeats (
  component_id TEXT PRIMARY KEY,
  component_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'warning', 'critical')),
  message TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tah_component_heartbeats_state_idx
  ON tah_component_heartbeats (state, last_seen_at DESC);

COMMIT;
