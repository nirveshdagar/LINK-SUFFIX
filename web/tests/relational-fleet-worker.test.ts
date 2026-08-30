import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelationalFleetV8Worker,
  RELATIONAL_FLEET_WORKER_VERSION,
} from "../lib/relational-fleet-worker.ts";

test("generates the relational v8 durable two-phase Fleet worker", () => {
  const script = buildRelationalFleetV8Worker(
    "https://bridge.example/api/script-bridge/jobs",
    "secret-token",
    "mcc-1000000000-001",
  );

  assert.equal(RELATIONAL_FLEET_WORKER_VERSION, "fleet-two-phase-durable-relay-v8");
  assert.match(script, /executeInParallel\("bootstrapAccount_", "continueFleetRelay_"/);
  assert.match(script, /manifest/);
  assert.match(script, /relational-lease-v2/);
  assert.match(script, /MAX_JOBS: 200/);
  assert.match(script, /MAX_ACCOUNTS: 50/);
  assert.match(script, /leaseToken/);
  assert.match(script, /exactSuffix/);
  assert.match(script, /AdsApp\.mutateAll/);
  assert.match(script, /appliedSuffix/);
  assert.match(script, /MIN_REMAINING_SECONDS/);
  assert.match(script, /readSuffixes_/);
  assert.match(script, /ACCOUNT_POLL_MS: 50000/);
  assert.doesNotMatch(script, /HOT_ADD_BOOTSTRAP_MS/);
  assert.doesNotMatch(script, /bootstrapDeadline/);
  assert.doesNotMatch(script, /verified \+= outcome\.verified;\s*break;/);
  assert.match(script, /POST_BATCH_SLEEP_MS: 50000/);
  assert.match(script, /query\.hotAdd = "1"/);
  assert.match(script, /action: "renew"/);
  assert.match(script, /renewLeases_/);
  assert.match(script, /AdsManagerApp\.select/);
  assert.ok(script.includes('replace(/\\D/g, "")'), "customer IDs must remove every non-digit character");
  assert.doesNotMatch(script, /replace\(\/D\/g/);
  assert.doesNotMatch(script, /developer[ _-]?token/i);
  assert.doesNotMatch(script, /client[ _-]?secret/i);
  assert.doesNotMatch(script, /refresh[ _-]?token/i);
  assert.doesNotMatch(script, /27 \* 60 \* 1000/);
});
