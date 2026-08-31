import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelationalFleetV11Worker,
  RELATIONAL_FLEET_WORKER_VERSION,
} from "../lib/relational-fleet-worker.ts";

test("generates the relational v11 two-phase resilient Fleet worker", () => {
  const script = buildRelationalFleetV11Worker(
    "https://bridge.example/api/script-bridge/jobs",
    "secret-token",
    "mcc-1000000000-001",
  );

  assert.equal(RELATIONAL_FLEET_WORKER_VERSION, "fleet-two-phase-resilient-relay-v11");
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
  assert.match(script, /phaseOneStopAtMs/);
  assert.match(script, /hardStopAtMs/);
  assert.match(script, /action: "complete"/);
  assert.match(script, /readSuffixes_/);
  const bootstrap = script.slice(script.indexOf("function bootstrapAccount_"), script.indexOf("function continueFleetRelay_"));
  assert.match(bootstrap, /while\s*\(hasExecutionTime_\(executionInfo, executionWindow\.phaseOneStopAtMs\)\)/, "parallel children must hold the first adaptive phase");
  assert.match(bootstrap, /CONFIG\.ACCOUNT_POLL_MS/, "parallel children must maintain V5's proven account pacing");
  assert.match(script, /ACCOUNT_POLL_MS: 50000/);
  assert.doesNotMatch(script, /HOT_ADD_BOOTSTRAP_MS/);
  assert.doesNotMatch(script, /bootstrapDeadline/);
  assert.doesNotMatch(script, /verified \+= outcome\.verified;\s*break;/);
  assert.match(script, /POST_BATCH_SLEEP_MS: 50000/);
  assert.match(script, /query\.hotAdd = "1"/);
  assert.match(script, /action: "renew"/);
  assert.match(script, /action: "window"/);
  assert.match(script, /recoverExecutionWindow_/);
  assert.match(script, /renewLeases_/);
  assert.match(script, /AdsManagerApp\.select/);
  const callback = script.slice(script.indexOf("function runContinuousRelay_"), script.indexOf("function executeCurrentAccountBatch_"));
  assert.match(callback, /while\s*\(hasExecutionTime_\(executionInfo, executionWindow\.hardStopAtMs\)\)/, "manager callback must maintain the second adaptive phase");
  assert.ok(script.includes('replace(/\\D/g, "")'), "customer IDs must remove every non-digit character");
  assert.doesNotMatch(script, /replace\(\/D\/g/);
  assert.doesNotMatch(script, /developer[ _-]?token/i);
  assert.doesNotMatch(script, /client[ _-]?secret/i);
  assert.doesNotMatch(script, /refresh[ _-]?token/i);
  assert.doesNotMatch(script, /27 \* 60 \* 1000/);
});
