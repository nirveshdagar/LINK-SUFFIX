import type { ApiAuthOptions } from "./api-auth";
import type { RateLimitConfig } from "./rate-limit";

export interface ApiPolicy {
  auth: ApiAuthOptions;
  rateLimit: RateLimitConfig;
}

export const API_POLICIES = {
  ads: {
    auth: { envVarName: "TAH_ADS_API_TOKEN" },
    rateLimit: {
      namespace: "ads",
      limit: 120,
      windowMs: 60_000,
      envVarName: "TAH_ADS_RATE_LIMIT",
      envVarWindowName: "TAH_ADS_RATE_LIMIT_WINDOW_MS",
    },
  },
  traffic: {
    auth: { envVarName: "TAH_API_BEARER_TOKEN" },
    rateLimit: {
      namespace: "traffic",
      limit: 120,
      windowMs: 60_000,
      envVarName: "TAH_TRAFFIC_RATE_LIMIT",
      envVarWindowName: "TAH_TRAFFIC_RATE_LIMIT_WINDOW_MS",
    },
  },
  track: {
    auth: {
      envVarName: "TAH_TRACK_API_TOKEN",
      fallbackEnvVarName: "TAH_API_BEARER_TOKEN",
    },
    rateLimit: {
      namespace: "track",
      limit: 120,
      windowMs: 60_000,
      envVarName: "TAH_TRACK_RATE_LIMIT",
      envVarWindowName: "TAH_TRACK_RATE_LIMIT_WINDOW_MS",
    },
  },
} as const satisfies Record<string, ApiPolicy>;
