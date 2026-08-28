export type ValidationResult<T> = {
  ok: boolean;
  errors: string[];
  value?: T;
};

type TrafficAction = "start_traffic" | "fire_one" | "stop_traffic" | "add_site" | "remove_site";
type AdsAction = "configure" | "refresh_suffix" | "push_to_ads";

interface BaseTrafficPayload {
  action: TrafficAction;
}

export interface TrafficStartPayload extends BaseTrafficPayload {
  action: "start_traffic";
  geo?: string;
  country?: string;
  state?: string;
  city?: string;
  sessions?: number;
  durationSec?: number;
  targetUrl?: string;
}

export interface TrafficFirePayload extends BaseTrafficPayload {
  action: "fire_one";
  geo?: string;
  country?: string;
  state?: string;
  city?: string;
  targetUrl?: string;
  sessionId?: string;
}

export interface TrafficStopPayload extends BaseTrafficPayload {
  action: "stop_traffic";
  sessionId?: string;
}

export interface TrafficAddSitePayload extends BaseTrafficPayload {
  action: "add_site";
  url: string;
  tags?: unknown;
  active?: boolean;
}

export interface TrafficRemoveSitePayload extends BaseTrafficPayload {
  action: "remove_site";
  index?: number;
}

type TrafficPayload = TrafficStartPayload | TrafficFirePayload | TrafficStopPayload | TrafficAddSitePayload | TrafficRemoveSitePayload;

interface AdsPostPayload {
  action: AdsAction;
}

interface AdsConfigurePayload extends AdsPostPayload {
  action: "configure";
  campaignId?: string;
  customerId?: string;
  clientId?: string;
  clientSecret?: string;
  developerToken?: string;
  refreshToken?: string;
  loginCustomerId?: string;
}

type AdsPayload = AdsConfigurePayload | Omit<AdsPostPayload, "action"> & {
  action: "refresh_suffix" | "push_to_ads";
};

interface TrackPostPayload {
  redirectChain: Array<{ url: string; status: number }>;
}

export interface TrafficSitesState {
  sites: Array<{
    url: string;
    tags: string[];
    active: boolean;
    addedAt: number;
  }>;
  suffix: string;
}

export interface AdsGetState {
  campaignId: string;
  customerId: string;
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  hasCredentials: boolean;
  pushHistory: Array<{ at: string; suffix: string; result?: string; error?: string }>;
}

function trimText(value: unknown, max = 2048) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.slice(0, Math.max(1, Math.min(max, text.length)));
}

function toAction(raw: unknown, actions: readonly string[]) {
  if (typeof raw !== "string") return "";
  return actions.includes(raw) ? raw : "";
}

function isStatusCode(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 100 && value <= 599;
}

export function formatValidationError<T>(result: ValidationResult<T>) {
  return result.errors.join("; ");
}

export function validateTrafficGet(input: URLSearchParams | Record<string, string> | undefined): ValidationResult<{ action: "stats" | "sessions" | "sites" }> {
  const raw = input instanceof URLSearchParams
    ? input.get("action")
    : input?.action;
  const action = toAction(raw, ["stats", "sessions", "sites"]);
  if (!action) {
    return {
      ok: false,
      errors: ["action must be one of: stats, sessions, sites"],
    };
  }
  return { ok: true, errors: [], value: { action: action as "stats" | "sessions" | "sites" } };
}

export function validateTrafficPost(input: unknown): ValidationResult<TrafficPayload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }
  const raw = input as Record<string, unknown>;
  const action = toAction(raw.action, ["start_traffic", "fire_one", "stop_traffic", "add_site", "remove_site"]);
  if (!action) {
    return { ok: false, errors: ["action must be one of: start_traffic, fire_one, stop_traffic, add_site, remove_site"] };
  }

  if (action === "start_traffic") {
    const sessions = typeof raw.sessions === "number" ? Math.trunc(raw.sessions) : NaN;
    const durationSec = typeof raw.durationSec === "number" ? Math.trunc(raw.durationSec) : NaN;
    const targetUrl = trimText(raw.targetUrl, 1024);
    if (targetUrl && !/^https?:\/\//i.test(targetUrl) && !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(targetUrl)) {
      return { ok: false, errors: ["targetUrl must be a valid url or domain"] };
    }
    if (Number.isFinite(sessions) && (sessions < 1 || sessions > 40)) {
      return { ok: false, errors: ["sessions must be between 1 and 40"] };
    }
    if (Number.isFinite(durationSec) && (durationSec < 1 || durationSec > 3600)) {
      return { ok: false, errors: ["durationSec must be between 1 and 3600"] };
    }
    return {
      ok: true,
      errors: [],
      value: {
        action: "start_traffic",
        geo: trimText(raw.geo, 32),
        country: trimText(raw.country, 8).toUpperCase(),
        state: trimText(raw.state, 80),
        city: trimText(raw.city, 120),
        sessions: Number.isFinite(sessions) ? sessions : undefined,
        durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
        targetUrl: targetUrl || undefined,
      },
    };
  }

  if (action === "fire_one") {
    return {
      ok: true,
      errors: [],
      value: {
        action: "fire_one",
        geo: trimText(raw.geo, 32),
        country: trimText(raw.country, 8).toUpperCase(),
        state: trimText(raw.state, 80),
        city: trimText(raw.city, 120),
        targetUrl: trimText(raw.targetUrl, 1024) || undefined,
      },
    };
  }

  if (action === "stop_traffic") {
    return {
      ok: true,
      errors: [],
      value: { action: "stop_traffic", sessionId: trimText(raw.sessionId, 64) },
    };
  }

  if (action === "add_site") {
    const rawUrl = trimText(raw.url, 2048);
    if (!rawUrl) {
      return { ok: false, errors: ["url is required for add_site"] };
    }
    if (!Array.isArray(raw.tags)) {
      if (typeof raw.tags !== "undefined") {
        return { ok: false, errors: ["tags must be an array of strings"] };
      }
    }
    if (raw.active !== undefined && typeof raw.active !== "boolean") {
      return { ok: false, errors: ["active must be boolean"] };
    }
    return {
      ok: true,
      errors: [],
      value: {
        action: "add_site",
        url: rawUrl,
        tags: raw.tags,
        active: raw.active === undefined ? undefined : Boolean(raw.active),
      },
    };
  }

  if (action === "remove_site") {
    const index = typeof raw.index === "number" ? Math.trunc(raw.index) : Number.NaN;
    if (!Number.isFinite(index) || index < 0) {
      return { ok: false, errors: ["index must be a non-negative integer"] };
    }
    return { ok: true, errors: [], value: { action: "remove_site", index } };
  }

  return { ok: false, errors: ["unsupported action"] };
}

export function validateTrafficSitesState(input: unknown): ValidationResult<TrafficSitesState> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["state must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.sites)) {
    return { ok: false, errors: ["sites must be an array"] };
  }
  const sites = raw.sites
    .map((site, index) => {
      if (!site || typeof site !== "object" || Array.isArray(site)) return `site[${index}] must be an object`;
      const current = site as Record<string, unknown>;
      if (typeof current.url !== "string" || !current.url.trim()) return `site[${index}].url must be a non-empty string`;
      if (typeof current.tags !== "undefined" && !Array.isArray(current.tags)) return `site[${index}].tags must be an array`;
      if (typeof current.active !== "undefined" && typeof current.active !== "boolean") return `site[${index}].active must be boolean`;
      if (typeof current.addedAt !== "number" || !Number.isFinite(current.addedAt)) return `site[${index}].addedAt must be a number`;
      return "";
    })
    .filter(Boolean);
  if (sites.length) return { ok: false, errors: sites };
  const suffix = trimText(raw.suffix, 2048);
  return { ok: true, errors: [], value: { sites: raw.sites as TrafficSitesState["sites"], suffix } };
}

export function validateAdsPost(input: unknown): ValidationResult<AdsPayload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  const action = toAction(raw.action, ["configure", "refresh_suffix", "push_to_ads"]);
  if (!action) {
    return { ok: false, errors: ["action must be one of: configure, refresh_suffix, push_to_ads"] };
  }
  if (action === "configure") {
    const hasConfig = ["campaignId", "customerId", "loginCustomerId", "clientId", "clientSecret", "developerToken", "refreshToken"].some((field) => Object.prototype.hasOwnProperty.call(raw, field));
    if (!hasConfig) {
      return { ok: false, errors: ["at least one configuration field is required"] };
    }
    return {
      ok: true,
      errors: [],
      value: {
        action: "configure",
        campaignId: trimText(raw.campaignId, 120),
        customerId: trimText(raw.customerId, 30),
        loginCustomerId: trimText(raw.loginCustomerId, 30),
        clientId: trimText(raw.clientId, 200),
        clientSecret: trimText(raw.clientSecret, 200),
        developerToken: trimText(raw.developerToken, 200),
        refreshToken: trimText(raw.refreshToken, 500),
      },
    };
  }
  return { ok: true, errors: [], value: { action: action as "refresh_suffix" | "push_to_ads" } };
}

export function validateTrackPost(input: unknown): ValidationResult<TrackPostPayload> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.redirectChain)) {
    return { ok: false, errors: ["redirectChain must be an array"] };
  }
  const errors = raw.redirectChain
    .map((step, index) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) return `redirectChain[${index}] must be an object`;
      const item = step as Record<string, unknown>;
      if (typeof item.url !== "string" || !item.url.trim()) return `redirectChain[${index}].url must be a non-empty string`;
      if (!isStatusCode(item.status)) return `redirectChain[${index}].status must be an HTTP status code`;
      return "";
    })
    .filter(Boolean);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: { redirectChain: raw.redirectChain as TrackPostPayload["redirectChain"] },
  };
}

export function validateAdsGet(input: unknown): ValidationResult<AdsGetState> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["response must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.campaignId !== "string") return { ok: false, errors: ["campaignId must be a string"] };
  if (typeof raw.customerId !== "string") return { ok: false, errors: ["customerId must be a string"] };
  if (typeof raw.clientId !== "string") return { ok: false, errors: ["clientId must be a masked string"] };
  if (typeof raw.clientSecret !== "string") return { ok: false, errors: ["clientSecret must be a masked string"] };
  if (typeof raw.developerToken !== "string") return { ok: false, errors: ["developerToken must be a masked string"] };
  if (typeof raw.refreshToken !== "string") return { ok: false, errors: ["refreshToken must be a masked string"] };
  if (typeof raw.hasCredentials !== "boolean") return { ok: false, errors: ["hasCredentials must be boolean"] };
  if (!Array.isArray(raw.pushHistory)) return { ok: false, errors: ["pushHistory must be an array"] };
  return {
    ok: true,
    errors: [],
    value: {
      campaignId: raw.campaignId,
      customerId: raw.customerId,
      clientId: raw.clientId,
      clientSecret: raw.clientSecret,
      developerToken: raw.developerToken,
      refreshToken: raw.refreshToken,
      hasCredentials: raw.hasCredentials,
      pushHistory: raw.pushHistory as Array<{ at: string; suffix: string; result?: string; error?: string }>,
    },
  };
}
