/**
 * @tah/google-ads — Google Ads final_url_suffix updater
 *
 * Reads the latest suffix (the query-string portion extracted from a live
 * traffic run) and pushes it into a Google Ads campaign via the
 * final_url_suffix field.
 *
 * Auth: OAuth2 (refresh-token flow — not service-account).
 *       Obtain a refresh token once via:
 *       https://developers.google.com/ads/api/docs/oauth/playground
 */

import { existsSync, readFileSync } from "node:fs";

// ---- config shapes ----

export interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
  apiVersion?: string;
  maxRetries?: number;
  minimumMutationIntervalMs?: number;
  requestTimeoutMs?: number;
}

export interface UpdateOptions {
  validateOnly?: boolean;
  enforceMinimumInterval?: boolean;
}

export interface SuffixSource {
  getSuffix(): Promise<string>;
}

// ---- built-in suffix sources ----

export class JsonlSuffixSource implements SuffixSource {
  constructor(private path: string) {}

  async getSuffix(): Promise<string> {
    if (!this.fileExists()) return "";
    const text = readFileSync(this.path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]!);
        const events = ev.events ?? [];
        const last = [...events].reverse().find(
          (e: any) => e.ta_signal?.main_document === "true"
        ) ?? events.at(-1);
        if (last?.url) {
          const q = last.url.indexOf("?");
          if (q >= 0) return last.url.slice(q + 1);
        }
      } catch { /* skip bad line */ }
    }
    return "";
  }

  private fileExists(): boolean {
    try { return existsSync(this.path); } catch { return false; }
  }
}

export class FileSuffixSource implements SuffixSource {
  constructor(private path: string) {}
  async getSuffix(): Promise<string> {
    if (!existsSync(this.path)) return "";
    return readFileSync(this.path, "utf8").trim();
  }
}

// ---- result type ----

export interface UpdateResult {
  customerId: string;
  resourceName: string;
  type: "campaign" | "ad_group" | "ad";
  previousSuffix: string;
  newSuffix: string;
  updatedAt: string;
  mutated: boolean;
  validateOnly: boolean;
  requestId?: string;
}

// ---- helpers ----

interface ApiResponse<T> {
  body: T;
  requestId?: string;
}

const campaignMutationTails = new Map<string, Promise<void>>();
const lastCampaignMutationAt = new Map<string, number>();

function normalizeCustomerId(value: string, field = "customerId") {
  const normalized = String(value ?? "").replace(/-/g, "");
  if (!/^\d{6,15}$/.test(normalized)) throw new Error(`${field} must contain 6-15 digits`);
  return normalized;
}

function normalizeCampaignId(value: string) {
  const normalized = String(value ?? "");
  if (!/^\d+$/.test(normalized)) throw new Error("campaignId must be a numeric Google Ads campaign ID");
  return normalized;
}

function validateSuffix(suffix: string) {
  if (typeof suffix !== "string" || suffix.length === 0) throw new Error("final URL suffix is required");
  if (suffix.startsWith("?")) throw new Error("final URL suffix must not include the leading question mark");
  if (suffix.includes("#")) throw new Error("final URL suffix must not include a URL fragment");
  if (/[\r\n]/.test(suffix)) throw new Error("final URL suffix must not contain line breaks");
  if (suffix.length > 2_048) throw new Error("final URL suffix exceeds 2048 characters");
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withCampaignMutationLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = campaignMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  campaignMutationTails.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (campaignMutationTails.get(key) === tail) campaignMutationTails.delete(key);
  }
}

function errorMessage(body: any, fallback: string) {
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

export class GoogleAdsMutationIntervalError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Campaign mutation interval has not elapsed; retry in ${Math.ceil(retryAfterMs / 1000)} seconds`);
    this.name = "GoogleAdsMutationIntervalError";
  }
}

// ---- Google Ads updater ----

export class GoogleAdsUpdater {
  private customerId: string;
  private refreshToken: string;
  private loginCustomerId?: string;
  private apiVersion: string;
  private maxRetries: number;
  private minimumMutationIntervalMs: number;
  private requestTimeoutMs: number;
  private accessToken?: { value: string; expiresAt: number };

  constructor(private cfg: GoogleAdsConfig) {
    this.customerId = normalizeCustomerId(cfg.customerId);
    this.refreshToken = cfg.refreshToken;
    this.loginCustomerId = cfg.loginCustomerId ? normalizeCustomerId(cfg.loginCustomerId, "loginCustomerId") : undefined;
    this.apiVersion = cfg.apiVersion ?? "v25";
    if (!/^v\d+(?:\.\d+)?$/.test(this.apiVersion)) throw new Error("Invalid Google Ads API version");
    this.maxRetries = Math.max(0, Math.min(6, cfg.maxRetries ?? 4));
    this.minimumMutationIntervalMs = Math.max(0, cfg.minimumMutationIntervalMs ?? 58_000);
    this.requestTimeoutMs = Math.max(5_000, Math.min(120_000, cfg.requestTimeoutMs ?? 30_000));
    for (const [name, value] of Object.entries({
      developerToken: cfg.developerToken,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
    })) {
      if (!String(value ?? "").trim()) throw new Error(`${name} is required`);
    }
  }

  private async getAccessToken(forceRefresh = false) {
    if (!forceRefresh && this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok || typeof payload.access_token !== "string") {
      throw new GoogleAdsApiError(errorMessage(payload, "Google OAuth token refresh failed"), response.status);
    }
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expires_in) || 3_600) * 1_000,
    };
    return this.accessToken.value;
  }

  private async request<T>(customerId: string, path: string, body: unknown, attempt = 0, forceRefresh = false): Promise<ApiResponse<T>> {
    try {
      const token = await this.getAccessToken(forceRefresh);
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "developer-token": this.cfg.developerToken,
      };
      if (this.loginCustomerId) headers["login-customer-id"] = this.loginCustomerId;
      const response = await fetch(`https://googleads.googleapis.com/${this.apiVersion}/customers/${customerId}/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const requestId = response.headers.get("request-id") ?? undefined;
      const payload = await response.json().catch(() => ({})) as T;
      if (response.ok) return { body: payload, requestId };
      if (response.status === 401 && !forceRefresh) {
        this.accessToken = undefined;
        return this.request(customerId, path, body, attempt, true);
      }
      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000
          : Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        await sleep(backoff);
        return this.request(customerId, path, body, attempt + 1, false);
      }
      throw new GoogleAdsApiError(
        errorMessage(payload, `Google Ads API returned HTTP ${response.status}`),
        response.status,
        requestId,
        retryable,
        payload,
      );
    } catch (error) {
      if (error instanceof GoogleAdsApiError) throw error;
      if (attempt < this.maxRetries) {
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500));
        return this.request(customerId, path, body, attempt + 1, false);
      }
      throw new GoogleAdsApiError(
        error instanceof Error ? error.message : String(error),
        0,
        undefined,
        true,
      );
    }
  }

  /**
   * Update the final_url_suffix on a single campaign.
   */
  async updateCampaignSuffix(
    customerId: string,
    campaignId: string,
    suffix: string,
    options: UpdateOptions = {},
  ): Promise<UpdateResult> {
    const normalizedCustomerId = normalizeCustomerId(customerId);
    const normalizedCampaignId = normalizeCampaignId(campaignId);
    validateSuffix(suffix);
    const resource = `customers/${normalizedCustomerId}/campaigns/${normalizedCampaignId}`;
    const key = `${normalizedCustomerId}:${normalizedCampaignId}`;

    return withCampaignMutationLock(key, async () => {
      const query = `SELECT campaign.final_url_suffix FROM campaign WHERE campaign.resource_name = '${resource}' LIMIT 1`;
      const search = await this.request<any>(normalizedCustomerId, "googleAds:search", { query });
      const row = Array.isArray(search.body?.results) ? search.body.results[0] : undefined;
      if (!row?.campaign) throw new GoogleAdsApiError("Google Ads campaign was not found or is not accessible", 404, search.requestId);
      const previousSuffix = String(row.campaign.finalUrlSuffix ?? "");

      if (previousSuffix === suffix && !options.validateOnly) {
        return {
          customerId: normalizedCustomerId,
          resourceName: resource,
          type: "campaign",
          previousSuffix,
          newSuffix: suffix,
          updatedAt: new Date().toISOString(),
          mutated: false,
          validateOnly: false,
          requestId: search.requestId,
        };
      }

      if (options.enforceMinimumInterval !== false && !options.validateOnly) {
        const lastMutation = lastCampaignMutationAt.get(key) ?? 0;
        const remaining = this.minimumMutationIntervalMs - (Date.now() - lastMutation);
        if (remaining > 0) throw new GoogleAdsMutationIntervalError(remaining);
      }

      const mutation = await this.request<any>(normalizedCustomerId, "campaigns:mutate", {
        operations: [{
          update: { resourceName: resource, finalUrlSuffix: suffix },
          updateMask: "finalUrlSuffix",
        }],
        partialFailure: false,
        validateOnly: options.validateOnly === true,
        responseContentType: "RESOURCE_NAME_ONLY",
      });
      if (!options.validateOnly) lastCampaignMutationAt.set(key, Date.now());

      return {
        customerId: normalizedCustomerId,
        resourceName: resource,
        type: "campaign",
        previousSuffix,
        newSuffix: suffix,
        updatedAt: new Date().toISOString(),
        mutated: !options.validateOnly,
        validateOnly: options.validateOnly === true,
        requestId: mutation.requestId,
      };
    });
  }

  /**
   * Update suffix on every ENABLED campaign whose name matches `filter`.
   */
  async updateCampaignsMatching(
    customerId: string,
    filter: RegExp,
    suffix: string,
  ): Promise<UpdateResult[]> {
    const normalizedCustomerId = normalizeCustomerId(customerId || this.customerId);
    const gaql = `
      SELECT campaign.id, campaign.name, campaign.final_url_suffix
      FROM campaign
      WHERE campaign.status = ENABLED`;

    const results: UpdateResult[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.request<any>(normalizedCustomerId, "googleAds:search", {
        query: gaql,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const row of response.body?.results ?? []) {
        filter.lastIndex = 0;
        if (!filter.test(String(row.campaign?.name ?? ""))) continue;
        const id = String(row.campaign?.id ?? "");
        const r = await this.updateCampaignSuffix(normalizedCustomerId, id, suffix);
        results.push(r);
      }
      pageToken = response.body?.nextPageToken;
    } while (pageToken);
    return results;
  }
}
