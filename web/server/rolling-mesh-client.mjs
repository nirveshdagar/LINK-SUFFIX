import { createHash } from "node:crypto";

export class RollingMeshClientError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "RollingMeshClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeGoogleId(value, label) {
  const normalized = String(value ?? "").replaceAll("-", "");
  if (!/^\d{1,20}$/.test(normalized)) {
    throw new RollingMeshClientError("INVALID_TARGET", `${label} must contain digits only.`);
  }
  return normalized;
}

function suffixHash(suffix) {
  return createHash("sha256").update(suffix, "utf8").digest("hex");
}

function loadConfig(options = {}) {
  const baseUrl = new URL(options.baseUrl ?? process.env.TAH_MESH_COORDINATOR_URL ?? "http://127.0.0.1:3202");
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(baseUrl.hostname.replace(/^\[(.+)\]$/, "$1"));
  if (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback)) {
    throw new RollingMeshClientError("INSECURE_COORDINATOR", "The rolling coordinator must use HTTPS unless it is on loopback.");
  }
  const sharedToken = String(options.sharedToken ?? process.env.TAH_MESH_SHARED_TOKEN ?? "");
  if (sharedToken.length < 32) {
    throw new RollingMeshClientError("MESH_NOT_CONFIGURED", "Configure TAH_MESH_SHARED_TOKEN before selecting Apps Script delivery.");
  }
  const customerId = normalizeGoogleId(
    options.customerId ?? process.env.TAH_MESH_PILOT_CUSTOMER_ID,
    "Pilot customer ID",
  );
  const campaignId = normalizeGoogleId(
    options.campaignId ?? process.env.TAH_MESH_PILOT_CAMPAIGN_ID,
    "Pilot campaign ID",
  );
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    sharedToken,
    customerId,
    campaignId,
    timeoutMs: Number(options.timeoutMs ?? 10_000),
    maxAttempts: Number(options.maxAttempts ?? 3),
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function assertTarget(config, customerIdValue, campaignIdValue) {
  const customerId = normalizeGoogleId(customerIdValue, "Google Ads customer ID");
  const campaignId = normalizeGoogleId(campaignIdValue, "Google Ads campaign ID");
  if (customerId !== config.customerId || campaignId !== config.campaignId) {
    throw new RollingMeshClientError(
      "TARGET_NOT_ALLOWLISTED",
      "The Rolling Apps Script Mesh pilot is locked to a different customer or campaign.",
      403,
    );
  }
  return { customerId, campaignId };
}

export function assertRollingMeshConfiguredForTarget(customerId, campaignId, options = {}) {
  const config = loadConfig(options);
  assertTarget(config, customerId, campaignId);
  return { baseUrl: config.baseUrl, customerId: config.customerId, campaignId: config.campaignId };
}

export function buildRollingMeshCapture(input, options = {}) {
  const config = loadConfig(options);
  const target = assertTarget(config, input?.customerId, input?.campaignId);
  if (typeof input?.suffix !== "string" || input.suffix.length === 0) {
    throw new RollingMeshClientError("INVALID_SUFFIX", "A non-empty exact suffix is required.");
  }
  const capturedAt = Date.parse(String(input.capturedAt ?? ""));
  if (!Number.isSafeInteger(capturedAt)) {
    throw new RollingMeshClientError("INVALID_CAPTURE_TIME", "The L4 capture time is invalid.");
  }
  const identity = [target.customerId, target.campaignId, input.runId, input.capturedAt, input.suffix].join("\u0000");
  return {
    customerId: target.customerId,
    campaignId: target.campaignId,
    captureId: `l4-${createHash("sha256").update(identity, "utf8").digest("hex")}`,
    capturedAt,
    suffix: input.suffix,
  };
}

async function sendCapture(config, body) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await config.fetchImpl(`${config.baseUrl}/v1/captures`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.sharedToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.ok === true) return result;
      const code = String(result?.error?.code ?? `HTTP_${response.status}`);
      const error = new RollingMeshClientError(code, "The rolling coordinator rejected the captured suffix.", response.status);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof RollingMeshClientError && error.statusCode < 500 && error.statusCode !== 429) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < config.maxAttempts) await config.sleep(250 * 2 ** (attempt - 1));
  }
  throw new RollingMeshClientError(
    "COORDINATOR_UNAVAILABLE",
    `The rolling coordinator did not accept the capture after ${config.maxAttempts} attempts.`,
    lastError?.statusCode,
  );
}

export async function publishCapturedSuffixToMesh(input, options = {}) {
  const config = loadConfig(options);
  const body = buildRollingMeshCapture(input, options);
  const expectedHash = suffixHash(body.suffix);
  const result = await sendCapture(config, body);
  if (!Number.isSafeInteger(result.version) || result.suffixHash !== expectedHash) {
    throw new RollingMeshClientError(
      "COORDINATOR_ACK_MISMATCH",
      "The coordinator acknowledgement did not match the exact captured suffix.",
    );
  }
  return {
    accepted: true,
    duplicate: result.duplicate === true,
    version: result.version,
    suffixHash: result.suffixHash,
  };
}
