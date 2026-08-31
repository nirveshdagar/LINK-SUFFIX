CREATE TABLE IF NOT EXISTS tah_proxy_providers (
  provider_id text PRIMARY KEY CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  provider_type text NOT NULL CHECK (provider_type IN ('iproyal','universal','custom')),
  enabled boolean NOT NULL DEFAULT true,
  protocol text NOT NULL CHECK (protocol IN ('http','https','socks5')),
  gateway_host text NOT NULL,
  gateway_ports integer[] NOT NULL CHECK (cardinality(gateway_ports) BETWEEN 1 AND 5000),
  auth_mode text NOT NULL CHECK (auth_mode IN ('username-password','token','ip-allowlist')),
  username_template text,
  password_template text,
  rotation_modes text[] NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tah_proxy_provider_secrets (
  provider_id text PRIMARY KEY REFERENCES tah_proxy_providers(provider_id) ON DELETE CASCADE,
  secret_envelope jsonb NOT NULL,
  key_id text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tah_proxy_pools (
  pool_id text PRIMARY KEY CHECK (pool_id ~ '^[a-z0-9][a-z0-9._-]{1,79}$'),
  provider_id text NOT NULL REFERENCES tah_proxy_providers(provider_id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  endpoint_ports integer[] NOT NULL CHECK (cardinality(endpoint_ports) BETWEEN 1 AND 5000),
  default_rotation_mode text NOT NULL CHECK (default_rotation_mode IN ('per-request','sticky-session','port-pool','provider-managed')),
  max_concurrent_per_endpoint integer NOT NULL DEFAULT 1 CHECK (max_concurrent_per_endpoint BETWEEN 1 AND 100),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, name)
);

CREATE SEQUENCE IF NOT EXISTS tah_proxy_lease_fencing_seq;

CREATE TABLE IF NOT EXISTS tah_proxy_leases (
  lease_id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES tah_proxy_providers(provider_id) ON DELETE RESTRICT,
  pool_id text NOT NULL REFERENCES tah_proxy_pools(pool_id) ON DELETE RESTRICT,
  campaign_record_id text NOT NULL,
  endpoint_key text NOT NULL,
  owner_id text NOT NULL,
  session_id text,
  rotation_mode text NOT NULL CHECK (rotation_mode IN ('per-request','sticky-session','port-pool','provider-managed')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','released','expired','quarantined')),
  fencing_token bigint NOT NULL DEFAULT nextval('tah_proxy_lease_fencing_seq'),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tah_proxy_leases_active_endpoint_idx
  ON tah_proxy_leases (provider_id, pool_id, endpoint_key) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS tah_proxy_leases_campaign_idx ON tah_proxy_leases (campaign_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tah_proxy_leases_expiry_idx ON tah_proxy_leases (expires_at) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS tah_proxy_health_samples (
  sample_id bigserial PRIMARY KEY,
  provider_id text NOT NULL REFERENCES tah_proxy_providers(provider_id) ON DELETE CASCADE,
  pool_id text REFERENCES tah_proxy_pools(pool_id) ON DELETE CASCADE,
  campaign_record_id text,
  endpoint_key text,
  healthy boolean NOT NULL,
  reason text,
  proxy_latency_ms integer,
  exit_ip inet,
  geo_verified boolean,
  payload_bytes bigint NOT NULL DEFAULT 0,
  browser_cpu_ms integer,
  browser_memory_bytes bigint,
  database_latency_ms integer,
  redis_latency_ms integer,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tah_proxy_health_provider_idx ON tah_proxy_health_samples (provider_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS tah_proxy_health_campaign_idx ON tah_proxy_health_samples (campaign_record_id, observed_at DESC) WHERE campaign_record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tah_proxy_circuit_states (
  provider_id text NOT NULL REFERENCES tah_proxy_providers(provider_id) ON DELETE CASCADE,
  pool_id text NOT NULL REFERENCES tah_proxy_pools(pool_id) ON DELETE CASCADE,
  endpoint_key text NOT NULL DEFAULT '*',
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half-open')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  opened_at timestamptz,
  retry_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, pool_id, endpoint_key)
);

CREATE TABLE IF NOT EXISTS tah_campaign_proxy_policies (
  campaign_record_id text PRIMARY KEY,
  primary_provider_id text NOT NULL REFERENCES tah_proxy_providers(provider_id) ON DELETE RESTRICT,
  primary_pool_id text NOT NULL REFERENCES tah_proxy_pools(pool_id) ON DELETE RESTRICT,
  rotation_mode text NOT NULL CHECK (rotation_mode IN ('per-request','sticky-session','port-pool','provider-managed')),
  sticky_ttl_seconds integer NOT NULL DEFAULT 1800 CHECK (sticky_ttl_seconds BETWEEN 60 AND 86400),
  geo jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  fallback_provider_ids text[] NOT NULL DEFAULT '{}',
  maximum_failovers integer NOT NULL DEFAULT 3 CHECK (maximum_failovers BETWEEN 0 AND 20),
  maximum_latency_ms integer CHECK (maximum_latency_ms IS NULL OR maximum_latency_ms BETWEEN 1 AND 120000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
