import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = readFileSync(path.join(process.cwd(), "migrations", "006_universal_proxy_registry.sql"), "utf8");

test("universal proxy migration contains every durable registry and lease boundary", () => {
  for (const table of [
    "tah_proxy_providers", "tah_proxy_provider_secrets", "tah_proxy_pools", "tah_proxy_leases",
    "tah_proxy_health_samples", "tah_proxy_circuit_states", "tah_campaign_proxy_policies",
  ]) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
});

test("proxy lease migration enforces active endpoint uniqueness and fencing", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS tah_proxy_leases_active_endpoint_idx[\s\S]+WHERE state = 'active'/);
  assert.match(migration, /fencing_token bigint NOT NULL DEFAULT nextval\('tah_proxy_lease_fencing_seq'\)/);
  assert.match(migration, /state IN \('active','released','expired','quarantined'\)/);
});

test("provider secrets are isolated from public provider configuration", () => {
  const providerTable = migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS tah_proxy_providers"), migration.indexOf("CREATE TABLE IF NOT EXISTS tah_proxy_provider_secrets"));
  assert.doesNotMatch(
    providerTable,
    /\b(ciphertext|secret_envelope|encrypted_secret|secret_payload|secret_value|access_token|api_token)\b/,
  );
  assert.match(migration, /tah_proxy_provider_secrets[\s\S]+secret_envelope jsonb NOT NULL/);
});
