export const RELATIONAL_FLEET_WORKER_VERSION = "fleet-hot-add-relay-v6";

export function buildRelationalFleetV6Worker(
  endpoint: string,
  token: string,
  shardId: string,
) {
  return `/**
 * Traffic Armour Rolling Apps Script Fleet v6 hot-add relay.
 * Install this copy once for shard ${shardId} in its Google Ads MCC,
 * authorize it, and schedule it Hourly.
 *
 * It uses a short supported executeInParallel child-account bootstrap, then
 * the manager callback discovers newly enrolled campaigns every 10 seconds
 * until Google's 60-minute manager-script guard.
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
  HOT_ADD_BOOTSTRAP_MS: 45000,
  BOOTSTRAP_RETRY_MS: 5000,
  IDLE_POLL_MS: 10000,
  POST_BATCH_SLEEP_MS: 10000,
  ERROR_BACKOFF_MS: 10000
});

function main() {
  const executionInfo = AdsApp.getExecutionInfo();
  const preview = executionInfo.isPreview();
  const invocationId = Utilities.getUuid();
  const manifest = fetchManifest_("manifest-" + invocationId, preview);

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
  if (!accountIds.length) {
    Logger.log("Traffic Armour Fleet " + CONFIG.SHARD_ID + " has no assigned child accounts.");
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
    .executeInParallel("bootstrapAccount_", "continueFleetRelay_", invocationId);
}

function bootstrapAccount_(invocationId) {
  const customerId = digits_(AdsApp.currentAccount().getCustomerId());
  const executionInfo = AdsApp.getExecutionInfo();
  const workerId = safeWorkerId_("child-" + customerId + "-" + invocationId);
  const bootstrapDeadline = Date.now() + CONFIG.HOT_ADD_BOOTSTRAP_MS;
  let completedCycles = 0;
  let total = 0;
  let verified = 0;

  while (
    executionInfo.getRemainingTime() > CONFIG.MIN_REMAINING_SECONDS &&
    Date.now() < bootstrapDeadline
  ) {
    try {
      const response = leaseJobs_(workerId, customerId, false);
      const jobs = Array.isArray(response.jobs) ? response.jobs : [];
      const outcome = executeCurrentAccountBatch_(jobs, customerId, workerId);
      completedCycles += 1;
      total += outcome.total;
      verified += outcome.verified;
      break;
    } catch (error) {
      Logger.log(
        "Traffic Armour Fleet account cycle failed for " + customerId +
        ": " + safeError_(error)
      );
      sleepWithinDeadline_(CONFIG.BOOTSTRAP_RETRY_MS, executionInfo);
    }
  }

  return JSON.stringify({
    customerId: customerId,
    cycles: completedCycles,
    total: total,
    verified: verified
  });
}

function continueFleetRelay_(executionResults) {
  let bootstrapOk = 0;
  let bootstrapFailed = 0;
  (executionResults || []).forEach(function(result) {
    if (String(result.getStatus()) === "OK") bootstrapOk += 1;
    else bootstrapFailed += 1;
  });
  Logger.log(
    "Traffic Armour Fleet " + CONFIG.SHARD_ID + " bootstrap complete: " +
    bootstrapOk + " account(s) ready, " + bootstrapFailed + " failed."
  );
  runContinuousRelay_();
}

function runContinuousRelay_() {
  const executionInfo = AdsApp.getExecutionInfo();
  const workerId = safeWorkerId_("manager-" + Utilities.getUuid());
  let completedBatches = 0;

  while (executionInfo.getRemainingTime() > CONFIG.MIN_REMAINING_SECONDS) {
    try {
      const response = leaseJobs_(workerId, "", true);
      const jobs = Array.isArray(response.jobs) ? response.jobs : [];
      if (jobs.length) {
        executeFleetBatch_(jobs, workerId);
        completedBatches += 1;
      }
      sleepWithinDeadline_(
        jobs.length ? CONFIG.POST_BATCH_SLEEP_MS : CONFIG.IDLE_POLL_MS,
        executionInfo
      );
    } catch (error) {
      Logger.log("Traffic Armour Fleet cycle failed: " + safeError_(error));
      sleepWithinDeadline_(CONFIG.ERROR_BACKOFF_MS, executionInfo);
    }
  }

  Logger.log(
    "Traffic Armour Fleet " + CONFIG.SHARD_ID +
    " completed its hourly relay before Google's 60-minute deadline after " +
    completedBatches +
    " callback batch(es). The Hourly schedule starts the next relay."
  );
}

function executeCurrentAccountBatch_(jobs, customerId, workerId) {
  const accountJobs = jobs.filter(function(job) {
    return digits_(job.customerId) === customerId;
  });
  const results = applyAndVerifyBatch_(accountJobs, customerId);
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
    Array.prototype.push.apply(results, applyAndVerifyBatch_(accountJobs, customerId));
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

function sleepWithinDeadline_(milliseconds, executionInfo) {
  const available = Math.max(
    0,
    (executionInfo.getRemainingTime() - CONFIG.MIN_REMAINING_SECONDS) * 1000
  );
  if (available > 0) Utilities.sleep(Math.min(milliseconds, available));
}

function applyAndVerifyBatch_(jobs, customerId) {
  if (!jobs.length) return [];

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

function fetchManifest_(workerId, preview) {
  const payload = bridgeGet_({
    workerId: workerId,
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
  bridgeRequest_(CONFIG.BRIDGE_URL, {
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

// Kept as a source-compatible alias for server code deployed before v6.
export const buildRelationalFleetV5Worker = buildRelationalFleetV6Worker;
