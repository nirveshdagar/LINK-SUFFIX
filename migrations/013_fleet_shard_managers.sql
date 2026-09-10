-- Independent metadata: no worker tokens, campaign rows or delivery history are changed.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS tah_fleet_shard_managers (
  shard_id text PRIMARY KEY CHECK (shard_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  manager_customer_id text NOT NULL CHECK (manager_customer_id ~ '^[0-9]{10}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Preserve an unambiguous existing assignment, including paused campaigns.
-- Mixed legacy ownership is not guessed; registration/enrollment will reject it.
INSERT INTO tah_fleet_shard_managers(shard_id, manager_customer_id)
SELECT shard_id, min(manager_customer_id)
FROM tah_campaign_targets
WHERE archived_at IS NULL
  AND shard_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
GROUP BY shard_id
HAVING count(DISTINCT manager_customer_id) = 1
   AND bool_and(manager_customer_id ~ '^[0-9]{10}$')
ON CONFLICT (shard_id) DO NOTHING;
