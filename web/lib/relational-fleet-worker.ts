export const RELATIONAL_FLEET_WORKER_VERSION = "fleet-callback-resilient-relay-v10";

export function buildRelationalFleetV10Worker(
  endpoint: string,
  token: string,
  shardId: string,
) {
  return `/**
 * Traffic Armour Rolling Apps Script Fleet v10 callback-resilient relay.
 * Install this copy once for shard ${shardId} in its Google Ads MCC,
 * authorize it, and schedule it Hourly.
 *
 * Each parallel child performs one short account pass and returns immediately.
 * The manager callback then keeps V5's proven delivery pacing, retains hot-add
 * discovery, renews immutable leases, and yields before the learned next trigger.
 */
const CONFIG = Object.freeze({
  BRIDGE_URL: ${JSON.stringify(endpoint)},
  BRIDGE_TOKEN: ${JSON.stringify(token)},
  SHARD_ID: ${JSON.stringify(shardId)},
  CONTRACT: "relational-lease-v2",
  MAX_ACCOUNTS: 50,
  MAX_JOBS: 200,
  WORKER_VERSION: "${RELATIONAL_FLEET_WORKER_VERSION}",
  MIN_REMAINING_SECONDS: 90,
  DEADLINE_GUARD_MS: 10000,
  IDLE_POLL_MS: 10000,
  POST_BATCH_SLEEP_MS: 50000,
  ERROR_BACKOFF_MS: 10000
});

function main() {
  const executionInfo = AdsApp.getExecutionInfo();
  const preview = executionInfo.isPreview();
  const invocationId = Utilities.getUuid();
  const manifest = fetchManifest_(invocationId, preview);

  if (preview) {
    Logger.log(
      "Traffic Armour Fleet preview connected for " + CONFIG.SHARD_ID +
      ". " + manifest.campaignCount + " campaign(s), " +
      manifest.accountIds.length +
      " child account(s). No jobs were leased and no campaign was changed."
    );
    return;
  }

  const managerId = digits_(AdsApp.currentAccount().getCustomerId());
  if (manifest.managerCustomerId && managerId !== manifest.managerCustomerId) {
    throw new Error(
      "This shard belongs to MCC " + manifest.managerCustomerId +
      ", but this script is running in MCC " + managerId + "."
    );
  }

  const accountIds = manifest.accountIds;
  const executionWindow = normalizeExecutionWindow_(manifest.executionWindow, invocationId);
  if (!executionWindow || executionWindow.shouldYield) {
    Logger.log(
      "Traffic Armour Fleet " + CONFIG.SHARD_ID +
      " yielded because the next Google hourly trigger is inside the protected handoff window."
    );
    completeInvocation_(invocationId, "yielded");
    return;
  }
  if (!accountIds.length) {
    Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + " has no assigned child accounts.");
    completeInvocation_(invocationId, "empty");
    return;
  }
  if (accountIds.length > CONFIG.MAX_ACCOUNTS) {
    throw new Error("Shard manifest exceeds the supported 50-account manager-script limit.");
  }

  Logger.log(
    "Traffic Armour Fleet " + CONFIG.SHARD_ID + " hourly relay started for " +
    accountIds.length + " child account(s) (" + CONFIG.WORKER_VERSION + ")."
  );
  AdsManagerApp.accounts()
    .withIds(accountIds)
    .withLimit(CONFIG.MAX_ACCOUNTS)
    .executeInParallel("bootstrapAccount_", "continueFleetRelay_", JSON.stringify(executionWindow));
}

function bootstrapAccount_(executionWindowJson) {
  const executionWindow = parseExecutionWindow_(executionWindowJson);
  if (!executionWindow) throw new Error("Adaptive execution window is missing");
  const customerId = digits_(AdsApp.currentAccount().getCustomerId());
  const executionInfo = AdsApp.getExecutionInfo();
  const workerId = safeWorkerId_("child-" + customerId + "-" + executionWindow.invocationId);
  let total = 0;
  let verified = 0;
  let failure = "";

  try {
    if (!hasExecutionTime_(executionInfo, executionWindow.phaseOneStopAtMs)) {
      throw new Error("The adaptive child window closed before this account pass began");
    }
    const response = leaseJobs_(workerId, customerId, false);
    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    const outcome = executeCurrentAccountBatch_(jobs, customerId, workerId);
    total = outcome.total;
    verified = outcome.verified;
  } catch (error) {
    failure = safeError_(error);
    Logger.log(
      "Traffic Armour Fleet account bootstrap failed for " + customerId +
      ": " + failure
    );
  }

  return JSON.stringify({
    customerId: customerId,
    cycles: 1,
    total: total,
    verified: verified,
    error: failure,
    executionWindow: executionWindow
  });
}

function continueFleetRelay_(executionResults) {
  let bootstrapOk = 0;
  let bootstrapFailed = 0;
  let executionWindow = null;
  const bootstrapErrors = [];
  (executionResults || []).forEach(function(result) {
    if (String(result.getStatus()) === "OK") {
      bootstrapOk += 1;
      try {
        const returned = JSON.parse(String(result.getReturnValue() || "{}"));
        if (!executionWindow) executionWindow = returned.executionWindow || null;
        if (returned.error) bootstrapErrors.push(String(returned.error));
      } catch (error) {
        bootstrapErrors.push("A child returned an unreadable bootstrap result");
      }
    } else {
      bootstrapFailed += 1;
      try {
        bootstrapErrors.push(String(result.getError() || "Unknown child execution failure"));
      } catch (error) {
        bootstrapErrors.push("Unknown child execution failure");
      }
    }
  });
  Logger.log(
    "Traffic Armour Fleet " + CONFIG.SHARD_ID + " bootstrap complete: " +
    bootstrapOk + " account(s) ready, " + bootstrapFailed + " failed."
  );
  if (!executionWindow) {
    try {
      executionWindow = recoverExecutionWindow_();
      Logger.log("Traffic Armour Fleet callback recovered its adaptive execution window from the bridge.");
    } catch (error) {
      Logger.log("Traffic Armour Fleet callback could not recover its execution window: " + safeError_(error));
      return;
    }
  }
  if (bootstrapErrors.length) {
    Logger.log(
      "Traffic Armour Fleet callback is continuing after child warning(s): " +
      bootstrapErrors.slice(0, 5).join(" | ")
    );
  }
  runContinuousRelay_(executionWindow);
}

function runContinuousRelay_(executionWindow) {
  const executionInfo = AdsApp.getExecutionInfo();
  const workerId = safeWorkerId_("manager-" + executionWindow.invocationId);
  let completedBatches = 0;

  while (hasExecutionTime_(executionInfo, executionWindow.hardStopAtMs)) {
    try {
      const response = leaseJobs_(workerId, "", true);
      const jobs = Array.isArray(response.jobs) ? response.jobs : [];
      if (jobs.length) {
        executeFleetBatch_(jobs, workerId);
        completedBatches += 1;
      }
      sleepWithinDeadline_(
        jobs.length ? CONFIG.POST_BATCH_SLEEP_MS : CONFIG.IDLE_POLL_MS,
        executionInfo,
        executionWindow.hardStopAtMs
      );
    } catch (error) {
      Logger.log("Traffic Armour Fleet cycle failed: " + safeError_(error));
      sleepWithinDeadline_(CONFIG.ERROR_BACKOFF_MS, executionInfo, executionWindow.hardStopAtMs);
    }
  }

  Logger.log(
    "Traffic Armour Fleet " + CONFIG.SHARD_ID +
    " completed its hourly relay before Google's 60-minute deadline after " +
    completedBatches +
    " callback batch(es). The worker yielded for the two-minute hourly handoff."
  );
  completeInvocation_(executionWindow.invocationId, "completed");
}

function executeCurrentAccountBatch_(jobs, customerId, workerId) {
  const accountJobs = jobs.filter(function(job) {
    return digits_(job.customerId) === customerId;
  });
  const results = applyAndVerifyBatch_(accountJobs, customerId, workerId);
  if (results.length) acknowledge_(workerId, results);
  const verified = results.filter(function(item) { return item.ok; }).length;
  if (results.length) {
    Logger.log(
      "Traffic Armour Fleet " + CONFIG.SHARD_ID + " account " + customerId +
      ": " + verified + " verified, " +
      (results.length - verified) + " failed."
    );
  }
  return { total: results.length, verified: verified };
}

function executeFleetBatch_(jobs, workerId) {
  const groups = {};
  jobs.forEach(function(job) {
    const customerId = digits_(job.customerId);
    if (!groups[customerId]) groups[customerId] = [];
    groups[customerId].push(job);
  });

  const accountIds = Object.keys(groups);
  if (accountIds.length > CONFIG.MAX_ACCOUNTS) {
    throw new Error("Shard returned more accounts than this worker permits.");
  }

  const accounts = AdsManagerApp.accounts()
    .withIds(accountIds)
    .withLimit(CONFIG.MAX_ACCOUNTS)
    .get();
  const processed = {};
  const results = [];

  while (accounts.hasNext()) {
    const account = accounts.next();
    const customerId = digits_(account.getCustomerId());
    const accountJobs = Array.isArray(groups[customerId]) ? groups[customerId] : [];
    if (!accountJobs.length) continue;
    processed[customerId] = true;
    AdsManagerApp.select(account);
    Array.prototype.push.apply(results, applyAndVerifyBatch_(accountJobs, customerId, workerId));
  }

  accountIds.forEach(function(customerId) {
    if (processed[customerId]) return;
    groups[customerId].forEach(function(job) {
      results.push(failedResult_(
        job,
        "Child account " + customerId + " is not linked to this MCC"
      ));
    });
  });

  if (results.length) acknowledge_(workerId, results);
  const verified = results.filter(function(item) { return item.ok; }).length;
  Logger.log(
    "Traffic Armour Fleet " + CONFIG.SHARD_ID + ": " + verified +
    " verified, " + (results.length - verified) + " failed."
  );
}

function hasExecutionTime_(executionInfo, stopAtMs) {
  return executionInfo.getRemainingTime() > CONFIG.MIN_REMAINING_SECONDS &&
    Date.now() + CONFIG.DEADLINE_GUARD_MS < Number(stopAtMs || 0);
}

function sleepWithinDeadline_(milliseconds, executionInfo, stopAtMs) {
  const googleAvailable = Math.max(
    0,
    (executionInfo.getRemainingTime() - CONFIG.MIN_REMAINING_SECONDS) * 1000
  );
  const adaptiveAvailable = Math.max(0, Number(stopAtMs || 0) - Date.now() - CONFIG.DEADLINE_GUARD_MS);
  const available = Math.min(googleAvailable, adaptiveAvailable);
  if (available > 0) Utilities.sleep(Math.min(milliseconds, available));
}

function applyAndVerifyBatch_(jobs, customerId, workerId) {
  if (!jobs.length) return [];

  renewLeases_(workerId, jobs);
  const before = readSuffixes_(jobs.map(function(job) { return job.campaignId; }));
  const changes = jobs.filter(function(job) {
    return before[job.campaignId] !== job.exactSuffix;
  });
  const mutationErrors = {};

  if (changes.length) {
    const operations = changes.map(function(job) {
      return {
        campaignOperation: {
          update: {
            resourceName:
              "customers/" + customerId + "/campaigns/" + job.campaignId,
            finalUrlSuffix: job.exactSuffix
          },
          updateMask: "finalUrlSuffix"
        }
      };
    });
    const mutationResults = AdsApp.mutateAll(operations, { partialFailure: true });
    mutationResults.forEach(function(result, index) {
      if (!result.isSuccessful()) {
        mutationErrors[changes[index].jobId] = result.getErrorMessages().join("; ");
      }
    });
    bestEffortRenewLeases_(workerId, jobs);
  }

  const after = readSuffixes_(jobs.map(function(job) { return job.campaignId; }));
  return jobs.map(function(job) {
    if (mutationErrors[job.jobId]) {
      return failedResult_(job, mutationErrors[job.jobId]);
    }
    if (after[job.campaignId] !== job.exactSuffix) {
      return failedResult_(
        job,
        "Read-back verification did not exactly match the captured suffix"
      );
    }
    return verifiedResult_(job, after[job.campaignId]);
  });
}

function readSuffixes_(campaignIds) {
  const ids = campaignIds
    .map(function(value) { return digits_(value); })
    .filter(Boolean);
  if (!ids.length) return {};

  const rows = AdsApp.search(
    "SELECT campaign.id, campaign.final_url_suffix FROM campaign " +
    "WHERE campaign.id IN (" + ids.join(",") + ")"
  );
  const suffixes = {};
  while (rows.hasNext()) {
    const row = rows.next();
    suffixes[String(row.campaign.id)] = String(row.campaign.finalUrlSuffix || "");
  }
  return suffixes;
}

function fetchManifest_(invocationId, preview) {
  const payload = bridgeGet_({
    workerId: "manifest-" + invocationId,
    invocationId: invocationId,
    manifest: "1",
    preview: preview ? "1" : "0"
  });
  payload.accountIds = Array.isArray(payload.accountIds) ? payload.accountIds : [];
  payload.managerCustomerId = digits_(payload.managerCustomerId || "");
  payload.campaignCount = Number(payload.campaignCount || 0);
  return payload;
}

function leaseJobs_(workerId, customerId, hotAdd) {
  const query = { workerId: workerId, maxJobs: String(CONFIG.MAX_JOBS) };
  if (customerId) query.customer = customerId;
  if (hotAdd) query.hotAdd = "1";
  return bridgeGet_(query);
}

function acknowledge_(workerId, results) {
  if (!results.length) return;
  const receipt = bridgeRequest_(CONFIG.BRIDGE_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      action: "ack",
      protocol: CONFIG.WORKER_VERSION,
      contract: CONFIG.CONTRACT,
      shardId: CONFIG.SHARD_ID,
      workerId: workerId,
      results: results
    })
  });
  if (receipt.allApplied === false) {
    Logger.log("Traffic Armour Fleet acknowledgement contained a stale or failed campaign result; the relay will continue.");
  }
}

function normalizeExecutionWindow_(raw, invocationId) {
  raw = raw || {};
  const phaseOneStopAtMs = Date.parse(String(raw.phaseOneStopAt || ""));
  const hardStopAtMs = Date.parse(String(raw.hardStopAt || ""));
  if (!Number.isFinite(phaseOneStopAtMs) || !Number.isFinite(hardStopAtMs)) return null;
  return {
    invocationId: safeWorkerId_(raw.invocationId || invocationId),
    phaseOneStopAtMs: phaseOneStopAtMs,
    hardStopAtMs: hardStopAtMs,
    nextExpectedStartAt: String(raw.nextExpectedStartAt || ""),
    handoffMarginMs: Number(raw.handoffMarginMs || 0),
    scheduleMode: String(raw.scheduleMode || "learning"),
    shouldYield: raw.shouldYield === true
  };
}

function parseExecutionWindow_(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || !Number.isFinite(Number(parsed.phaseOneStopAtMs)) || !Number.isFinite(Number(parsed.hardStopAtMs))) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function recoverExecutionWindow_() {
  const response = bridgeRequest_(CONFIG.BRIDGE_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      action: "window",
      protocol: CONFIG.WORKER_VERSION,
      contract: CONFIG.CONTRACT,
      shardId: CONFIG.SHARD_ID
    })
  });
  const recovered = normalizeExecutionWindow_(
    response.executionWindow,
    response.invocationId
  );
  if (!recovered || recovered.shouldYield) {
    throw new Error("The bridge has no active execution window for this callback");
  }
  return recovered;
}

function completeInvocation_(invocationId, status) {
  try {
    bridgeRequest_(CONFIG.BRIDGE_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        action: "complete",
        protocol: CONFIG.WORKER_VERSION,
        contract: CONFIG.CONTRACT,
        shardId: CONFIG.SHARD_ID,
        invocationId: invocationId,
        status: status
      })
    });
  } catch (error) {
    Logger.log("Traffic Armour Fleet completion heartbeat warning: " + safeError_(error));
  }
}

function renewLeases_(workerId, jobs) {
  if (!jobs.length) return;
  const response = bridgeRequest_(CONFIG.BRIDGE_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      action: "renew",
      protocol: CONFIG.WORKER_VERSION,
      contract: CONFIG.CONTRACT,
      shardId: CONFIG.SHARD_ID,
      workerId: workerId,
      leases: jobs.map(function(job) {
        return { jobId: job.jobId, leaseToken: job.leaseToken };
      })
    })
  });
  if (response.allRenewed === false) {
    throw new Error("One or more delivery leases became stale before Google Ads mutation");
  }
}

function bestEffortRenewLeases_(workerId, jobs) {
  try {
    renewLeases_(workerId, jobs);
  } catch (error) {
    Logger.log("Traffic Armour Fleet post-mutation lease renewal warning: " + safeError_(error));
  }
}

function bridgeGet_(query) {
  query.worker = CONFIG.WORKER_VERSION;
  query.protocol = CONFIG.WORKER_VERSION;
  query.contract = CONFIG.CONTRACT;
  query.shard = CONFIG.SHARD_ID;
  query.shardId = CONFIG.SHARD_ID;
  const parts = [];
  Object.keys(query).forEach(function(key) {
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(query[key]));
  });
  const separator = CONFIG.BRIDGE_URL.indexOf("?") >= 0 ? "&" : "?";
  return bridgeRequest_(CONFIG.BRIDGE_URL + separator + parts.join("&"), {
    method: "get"
  });
}

function bridgeRequest_(url, options) {
  options = options || {};
  options.muteHttpExceptions = true;
  options.headers = options.headers || {};
  options.headers.Authorization = "Bearer " + CONFIG.BRIDGE_TOKEN;
  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  const body = response.getContentText();
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (error) {
    throw new Error(
      "Bridge returned non-JSON HTTP " + status + ": " + body.slice(0, 300)
    );
  }
  if (status < 200 || status >= 300 || payload.ok === false) {
    throw new Error(
      "Bridge HTTP " + status + ": " +
      String(payload.error || body).slice(0, 500)
    );
  }
  return payload;
}

function verifiedResult_(job, observedSuffix) {
  return {
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    ok: true,
    status: "applied",
    appliedSuffix: observedSuffix
  };
}

function failedResult_(job, error) {
  return {
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    ok: false,
    status: "failed",
    error: safeError_(error).slice(0, 1000)
  };
}

function digits_(value) {
  return String(value || "").replace(/\\D/g, "");
}

function safeWorkerId_(value) {
  return String(value).replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 200);
}

function safeError_(error) {
  return error && error.message
    ? String(error.message)
    : String(error || "Unknown script error");
}
`;
}

// Source-compatible aliases keep existing imports working during rolling deploys.
export const buildRelationalFleetV9Worker = buildRelationalFleetV10Worker;
export const buildRelationalFleetV8Worker = buildRelationalFleetV10Worker;
export const buildRelationalFleetV7Worker = buildRelationalFleetV10Worker;
export const buildRelationalFleetV6Worker = buildRelationalFleetV10Worker;
export const buildRelationalFleetV5Worker = buildRelationalFleetV10Worker;
