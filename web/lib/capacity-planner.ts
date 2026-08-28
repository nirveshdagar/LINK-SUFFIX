export type TunnelMode = "none" | "quick" | "named";

export type CapacityCheckStatus = "pass" | "warn" | "fail";

export interface CapacityInputs {
  campaigns: number;
  savedCampaignLimit: number;
  activeCampaignLimit: number;
  browserWorkers: number;
  dedicatedGatewayPorts: number;
  campaignsPerShard: number;
  configuredShardCount?: number;
  maxAccountsPerScript: number;
  maxConcurrentShardScripts: number;
  captureIntervalSeconds: number;
  fleetPollSeconds: number;
  fleetActiveSecondsPerHour: number;
  targetMaxUtilization: number;
  averagePageMegabytes: number;
  networkOverheadRatio: number;
  measuredBrowserMemoryMb?: number;
  availableMemoryMb?: number;
  availableNetworkMbps?: number;
  measuredDatabaseWritesPerSecond?: number;
  tunnelMode: TunnelMode;
  soakTestHours: number;
  requiredSoakTestHours: number;
}

export interface CapacityCheck {
  id: string;
  label: string;
  status: CapacityCheckStatus;
  detail: string;
}

export interface CapacityPlan {
  input: CapacityInputs & { configuredShardCount: number };
  browser: {
    requestedConcurrentCampaigns: number;
    admittedConcurrentCampaigns: number;
    queuedCampaigns: number;
    workerShortfall: number;
    gatewayPortShortfall: number;
    trueParallelReady: boolean;
  };
  fleet: {
    baseShardCount: number;
    configuredShardCount: number;
    recommendedShardCount: number;
    recommendedCampaignsPerShard: number;
    arrivalRatePerSecond: number;
    rawServiceRatePerSecond: number;
    effectiveServiceRatePerSecond: number;
    utilization: number;
    reserveMargin: number;
    stableForNewestValue: boolean;
    safetyHeadroomReady: boolean;
    everyCaptureMathematicallyPossible: boolean;
    googleFanoutReady: boolean;
    shardExecutionQuotaReady: boolean;
  };
  infrastructure: {
    estimatedNetworkMbps: number;
    requiredDatabaseWritesPerSecond: number;
    estimatedMemoryMb: number | null;
    memoryMeasuredAndReady: boolean;
    networkMeasuredAndReady: boolean;
    databaseMeasuredAndReady: boolean;
    namedTunnelReady: boolean;
    soakReady: boolean;
  };
  managedQueueReady: boolean;
  productionReadyForLatestValue: boolean;
  productionReadyForEveryCapture: boolean;
  checks: CapacityCheck[];
  assumptions: string[];
}

export const DEFAULT_DEDICATED_GATEWAY_PORT_COUNT = 104;

export const DEFAULT_CAPACITY_INPUT: CapacityInputs = Object.freeze({
  campaigns: 500,
  savedCampaignLimit: 5_000,
  activeCampaignLimit: 500,
  browserWorkers: 20,
  dedicatedGatewayPorts: DEFAULT_DEDICATED_GATEWAY_PORT_COUNT,
  campaignsPerShard: 40,
  maxAccountsPerScript: 50,
  maxConcurrentShardScripts: 30,
  captureIntervalSeconds: 58,
  fleetPollSeconds: 50,
  fleetActiveSecondsPerHour: 56 * 60,
  targetMaxUtilization: 0.65,
  averagePageMegabytes: 5,
  networkOverheadRatio: 0.3,
  tunnelMode: "none",
  soakTestHours: 0,
  requiredSoakTestHours: 72,
});

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function requireNonNegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function requireOptionalPositiveNumber(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new RangeError(`${name} must be a finite positive number when supplied`);
  }
}

function validateInput(input: CapacityInputs & { configuredShardCount: number }): void {
  requirePositiveInteger("campaigns", input.campaigns);
  requirePositiveInteger("savedCampaignLimit", input.savedCampaignLimit);
  requirePositiveInteger("activeCampaignLimit", input.activeCampaignLimit);
  requirePositiveInteger("browserWorkers", input.browserWorkers);
  requirePositiveInteger("dedicatedGatewayPorts", input.dedicatedGatewayPorts);
  requirePositiveInteger("campaignsPerShard", input.campaignsPerShard);
  requirePositiveInteger("configuredShardCount", input.configuredShardCount);
  requirePositiveInteger("maxAccountsPerScript", input.maxAccountsPerScript);
  requirePositiveInteger("maxConcurrentShardScripts", input.maxConcurrentShardScripts);
  requirePositiveInteger("captureIntervalSeconds", input.captureIntervalSeconds);
  requirePositiveInteger("fleetPollSeconds", input.fleetPollSeconds);
  requirePositiveInteger("fleetActiveSecondsPerHour", input.fleetActiveSecondsPerHour);
  requireNonNegativeNumber("averagePageMegabytes", input.averagePageMegabytes);
  requireNonNegativeNumber("networkOverheadRatio", input.networkOverheadRatio);
  requireNonNegativeNumber("soakTestHours", input.soakTestHours);
  requirePositiveInteger("requiredSoakTestHours", input.requiredSoakTestHours);
  requireOptionalPositiveNumber("measuredBrowserMemoryMb", input.measuredBrowserMemoryMb);
  requireOptionalPositiveNumber("availableMemoryMb", input.availableMemoryMb);
  requireOptionalPositiveNumber("availableNetworkMbps", input.availableNetworkMbps);
  requireOptionalPositiveNumber(
    "measuredDatabaseWritesPerSecond",
    input.measuredDatabaseWritesPerSecond,
  );

  if (input.fleetActiveSecondsPerHour > 3_600) {
    throw new RangeError("fleetActiveSecondsPerHour cannot exceed 3600");
  }

  if (
    !Number.isFinite(input.targetMaxUtilization) ||
    input.targetMaxUtilization <= 0 ||
    input.targetMaxUtilization >= 1
  ) {
    throw new RangeError("targetMaxUtilization must be greater than 0 and less than 1");
  }
}

function check(
  id: string,
  label: string,
  status: CapacityCheckStatus,
  detail: string,
): CapacityCheck {
  return { id, label, status, detail };
}

function rounded(value: number, precision = 4): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export function planCapacity(overrides: Partial<CapacityInputs> = {}): CapacityPlan {
  const campaigns = overrides.campaigns ?? DEFAULT_CAPACITY_INPUT.campaigns;
  const campaignsPerShard =
    overrides.campaignsPerShard ?? DEFAULT_CAPACITY_INPUT.campaignsPerShard;
  const configuredShardCount =
    overrides.configuredShardCount ?? Math.ceil(campaigns / campaignsPerShard);

  const input: CapacityInputs & { configuredShardCount: number } = {
    ...DEFAULT_CAPACITY_INPUT,
    ...overrides,
    campaigns,
    campaignsPerShard,
    configuredShardCount,
  };

  validateInput(input);

  const requestedConcurrentCampaigns = Math.min(input.campaigns, input.activeCampaignLimit);
  const admittedConcurrentCampaigns = Math.min(
    requestedConcurrentCampaigns,
    input.browserWorkers,
    input.dedicatedGatewayPorts,
  );
  const trueParallelReady =
    requestedConcurrentCampaigns === input.campaigns &&
    admittedConcurrentCampaigns === input.campaigns;

  const baseShardCount = Math.ceil(input.campaigns / input.campaignsPerShard);
  const dutyCycle = input.fleetActiveSecondsPerHour / 3_600;
  const arrivalRatePerSecond = input.campaigns / input.captureIntervalSeconds;
  const rawServiceRatePerSecond =
    (input.configuredShardCount * input.campaignsPerShard) / input.fleetPollSeconds;
  const effectiveServiceRatePerSecond = rawServiceRatePerSecond * dutyCycle;
  const utilization = arrivalRatePerSecond / effectiveServiceRatePerSecond;
  const reserveMargin =
    (effectiveServiceRatePerSecond - arrivalRatePerSecond) / arrivalRatePerSecond;
  const effectiveRatePerShard =
    (input.campaignsPerShard / input.fleetPollSeconds) * dutyCycle;
  const recommendedShardCount = Math.ceil(
    arrivalRatePerSecond / (effectiveRatePerShard * input.targetMaxUtilization),
  );
  const recommendedCampaignsPerShard = Math.ceil(input.campaigns / recommendedShardCount);
  const googleFanoutReady = input.campaignsPerShard <= input.maxAccountsPerScript;
  const shardExecutionQuotaReady =
    input.configuredShardCount <= input.maxConcurrentShardScripts &&
    recommendedShardCount <= input.maxConcurrentShardScripts;
  const stableForNewestValue =
    input.configuredShardCount >= baseShardCount && utilization < 1 && googleFanoutReady;
  const safetyHeadroomReady =
    input.configuredShardCount >= recommendedShardCount &&
    utilization <= input.targetMaxUtilization &&
    googleFanoutReady &&
    shardExecutionQuotaReady;
  const everyCaptureMathematicallyPossible =
    input.fleetActiveSecondsPerHour === 3_600 && safetyHeadroomReady;

  const estimatedNetworkMbps =
    arrivalRatePerSecond *
    input.averagePageMegabytes *
    8 *
    (1 + input.networkOverheadRatio);
  const requiredDatabaseWritesPerSecond =
    (arrivalRatePerSecond * 3) / input.targetMaxUtilization;
  const estimatedMemoryMb =
    input.measuredBrowserMemoryMb === undefined
      ? null
      : input.measuredBrowserMemoryMb * input.campaigns;
  const memoryMeasuredAndReady =
    estimatedMemoryMb !== null &&
    input.availableMemoryMb !== undefined &&
    input.availableMemoryMb >= estimatedMemoryMb;
  const networkMeasuredAndReady =
    input.availableNetworkMbps !== undefined &&
    input.availableNetworkMbps >= estimatedNetworkMbps;
  const databaseMeasuredAndReady =
    input.measuredDatabaseWritesPerSecond !== undefined &&
    input.measuredDatabaseWritesPerSecond >= requiredDatabaseWritesPerSecond;
  const namedTunnelReady = input.tunnelMode === "named";
  const soakReady = input.soakTestHours >= input.requiredSoakTestHours;
  const managedQueueReady = input.campaigns <= input.savedCampaignLimit && stableForNewestValue;

  const infrastructureMeasuredAndReady =
    memoryMeasuredAndReady &&
    networkMeasuredAndReady &&
    databaseMeasuredAndReady &&
    namedTunnelReady &&
    soakReady;
  const productionReadyForLatestValue =
    managedQueueReady &&
    trueParallelReady &&
    safetyHeadroomReady &&
    infrastructureMeasuredAndReady;
  const productionReadyForEveryCapture =
    productionReadyForLatestValue && everyCaptureMathematicallyPossible;

  const workerShortfall = Math.max(0, input.campaigns - input.browserWorkers);
  const gatewayPortShortfall = Math.max(0, input.campaigns - input.dedicatedGatewayPorts);

  const checks: CapacityCheck[] = [
    check(
      "saved-capacity",
      "Saved campaign capacity",
      input.campaigns <= input.savedCampaignLimit ? "pass" : "fail",
      `${input.campaigns} requested of ${input.savedCampaignLimit} available slots.`,
    ),
    check(
      "active-limit",
      "Configured active limit",
      input.activeCampaignLimit >= input.campaigns ? "pass" : "fail",
      `${input.activeCampaignLimit} active slots configured for ${input.campaigns} campaigns.`,
    ),
    check(
      "browser-workers",
      "Browser worker capacity",
      workerShortfall === 0 ? "pass" : "fail",
      workerShortfall === 0
        ? `${input.browserWorkers} workers cover all campaigns.`
        : `${workerShortfall} additional isolated browser workers are required for true parallel operation.`,
    ),
    check(
      "gateway-ports",
      "Dedicated proxy gateway ports",
      gatewayPortShortfall === 0 ? "pass" : "fail",
      gatewayPortShortfall === 0
        ? `${input.dedicatedGatewayPorts} dedicated ports cover all campaigns.`
        : `${gatewayPortShortfall} additional dedicated ports are required by the one-port-per-running-campaign lock.`,
    ),
    check(
      "fleet-stability",
      "Fleet newest-value stability",
      stableForNewestValue ? "pass" : "fail",
      stableForNewestValue
        ? `Effective capacity ${rounded(effectiveServiceRatePerSecond)} updates/s exceeds arrival ${rounded(arrivalRatePerSecond)} updates/s.`
        : `Effective capacity ${rounded(effectiveServiceRatePerSecond)} updates/s does not safely cover arrival ${rounded(arrivalRatePerSecond)} updates/s.`,
    ),
    check(
      "fleet-headroom",
      "Fleet safety headroom",
      safetyHeadroomReady ? "pass" : stableForNewestValue ? "warn" : "fail",
      `${input.configuredShardCount} shards configured; ${recommendedShardCount} are required to hold utilization at or below ${rounded(input.targetMaxUtilization * 100, 1)}%.`,
    ),
    check(
      "google-account-fanout",
      "Google account fan-out",
      googleFanoutReady ? "pass" : "fail",
      `${input.campaignsPerShard} worst-case child accounts per shard against a ${input.maxAccountsPerScript}-account planning limit.`,
    ),
    check(
      "google-shard-executions",
      "Concurrent shard execution budget",
      shardExecutionQuotaReady ? "pass" : "fail",
      `${recommendedShardCount} recommended shard scripts against a ${input.maxConcurrentShardScripts}-execution planning limit.`,
    ),
    check(
      "continuous-delivery",
      "Every-capture continuity",
      everyCaptureMathematicallyPossible ? "pass" : "warn",
      everyCaptureMathematicallyPossible
        ? "The capacity model has no planned hourly delivery gap."
        : `${3_600 - input.fleetActiveSecondsPerHour} seconds per hour have no planned Fleet polling; newest-value delivery remains possible, but intermediate captures can be superseded.`,
    ),
    check(
      "public-ingress",
      "Stable public HTTPS ingress",
      namedTunnelReady ? "pass" : "fail",
      namedTunnelReady
        ? "A named production HTTPS endpoint is configured."
        : input.tunnelMode === "quick"
          ? "A temporary Quick Tunnel is configured; its hostname and availability are not production-stable."
          : "No named production HTTPS endpoint is configured.",
    ),
    check(
      "memory-proof",
      "Measured browser memory capacity",
      memoryMeasuredAndReady ? "pass" : "fail",
      memoryMeasuredAndReady
        ? `${rounded(estimatedMemoryMb ?? 0, 0)} MB estimated against ${rounded(input.availableMemoryMb ?? 0, 0)} MB available.`
        : "Per-browser memory and available production memory have not both been measured at target workload.",
    ),
    check(
      "network-proof",
      "Measured network capacity",
      networkMeasuredAndReady ? "pass" : "fail",
      `${rounded(estimatedNetworkMbps, 1)} Mbps estimated at ${input.averagePageMegabytes} MB per journey; measured available throughput is ${input.availableNetworkMbps ?? "not supplied"} Mbps.`,
    ),
    check(
      "database-proof",
      "Measured database write capacity",
      databaseMeasuredAndReady ? "pass" : "fail",
      `${rounded(requiredDatabaseWritesPerSecond, 1)} writes/s required at the target utilization; measured capacity is ${input.measuredDatabaseWritesPerSecond ?? "not supplied"} writes/s.`,
    ),
    check(
      "soak-proof",
      "Production soak evidence",
      soakReady ? "pass" : "fail",
      `${input.soakTestHours} of ${input.requiredSoakTestHours} required hours completed at target load.`,
    ),
  ];

  return {
    input,
    browser: {
      requestedConcurrentCampaigns,
      admittedConcurrentCampaigns,
      queuedCampaigns: Math.max(0, input.campaigns - admittedConcurrentCampaigns),
      workerShortfall,
      gatewayPortShortfall,
      trueParallelReady,
    },
    fleet: {
      baseShardCount,
      configuredShardCount: input.configuredShardCount,
      recommendedShardCount,
      recommendedCampaignsPerShard,
      arrivalRatePerSecond: rounded(arrivalRatePerSecond),
      rawServiceRatePerSecond: rounded(rawServiceRatePerSecond),
      effectiveServiceRatePerSecond: rounded(effectiveServiceRatePerSecond),
      utilization: rounded(utilization),
      reserveMargin: rounded(reserveMargin),
      stableForNewestValue,
      safetyHeadroomReady,
      everyCaptureMathematicallyPossible,
      googleFanoutReady,
      shardExecutionQuotaReady,
    },
    infrastructure: {
      estimatedNetworkMbps: rounded(estimatedNetworkMbps),
      requiredDatabaseWritesPerSecond: rounded(requiredDatabaseWritesPerSecond),
      estimatedMemoryMb: estimatedMemoryMb === null ? null : rounded(estimatedMemoryMb, 0),
      memoryMeasuredAndReady,
      networkMeasuredAndReady,
      databaseMeasuredAndReady,
      namedTunnelReady,
      soakReady,
    },
    managedQueueReady,
    productionReadyForLatestValue,
    productionReadyForEveryCapture,
    checks,
    assumptions: [
      "Worst case is one campaign per Google Ads child account.",
      "Every campaign produces one newest suffix at the configured capture interval.",
      "Each running campaign owns one dedicated proxy gateway port.",
      "Fleet capacity uses the configured polling interval and hourly active window.",
      "Current-only queue semantics may supersede an older unapplied suffix with a newer suffix.",
      "Network sizing includes the configured transport overhead but excludes unrelated host traffic.",
      "A mathematical pass is not a substitute for measured memory, network, database, proxy, and soak evidence.",
    ],
  };
}

function optionalEnvNumber(
  env: Record<string, string | undefined>,
  names: string[],
): number | undefined {
  const raw = names.map((name) => env[name]).find((value) => value !== undefined && value !== "");
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`${names[0]} must be numeric`);
  }
  return parsed;
}

function detectTunnelMode(env: Record<string, string | undefined>): TunnelMode {
  const explicit = env.TAH_TUNNEL_MODE;
  if (explicit === "none" || explicit === "quick" || explicit === "named") return explicit;
  const publicBaseUrl = env.TAH_PUBLIC_BASE_URL ?? "";
  if (/\.trycloudflare\.com\/?$/i.test(publicBaseUrl)) return "quick";
  if (/^https:\/\//i.test(publicBaseUrl)) return "named";
  return "none";
}

export function capacityInputFromEnvironment(
  env: Record<string, string | undefined>,
  overrides: Partial<CapacityInputs> = {},
): Partial<CapacityInputs> {
  const fromEnvironment: Partial<CapacityInputs> = {
    campaigns: optionalEnvNumber(env, ["TAH_CAPACITY_TARGET"]),
    savedCampaignLimit: optionalEnvNumber(env, ["TAH_SAVED_CAMPAIGN_LIMIT"]),
    activeCampaignLimit: optionalEnvNumber(env, [
      "TAH_ACTIVE_CAMPAIGN_LIMIT",
      "TAH_ACTIVE_LIMIT",
    ]),
    browserWorkers: optionalEnvNumber(env, ["TAH_MAX_LOCAL_WORKERS"]),
    dedicatedGatewayPorts: optionalEnvNumber(env, ["TAH_GATEWAY_PORT_COUNT"]),
    campaignsPerShard: optionalEnvNumber(env, ["TAH_FLEET_CAMPAIGNS_PER_SHARD"]),
    configuredShardCount: optionalEnvNumber(env, ["TAH_FLEET_SHARD_COUNT"]),
    maxAccountsPerScript: optionalEnvNumber(env, ["TAH_GOOGLE_MAX_ACCOUNTS_PER_SCRIPT"]),
    maxConcurrentShardScripts: optionalEnvNumber(env, [
      "TAH_GOOGLE_MAX_CONCURRENT_SHARD_SCRIPTS",
    ]),
    captureIntervalSeconds: optionalEnvNumber(env, ["TAH_CAPTURE_INTERVAL_SECONDS"]),
    fleetPollSeconds: optionalEnvNumber(env, ["TAH_FLEET_POLL_SECONDS"]),
    fleetActiveSecondsPerHour: optionalEnvNumber(env, [
      "TAH_FLEET_ACTIVE_SECONDS_PER_HOUR",
    ]),
    targetMaxUtilization: optionalEnvNumber(env, ["TAH_TARGET_MAX_UTILIZATION"]),
    averagePageMegabytes: optionalEnvNumber(env, ["TAH_AVERAGE_PAGE_MEGABYTES"]),
    networkOverheadRatio: optionalEnvNumber(env, ["TAH_NETWORK_OVERHEAD_RATIO"]),
    measuredBrowserMemoryMb: optionalEnvNumber(env, ["TAH_MEASURED_BROWSER_MEMORY_MB"]),
    availableMemoryMb: optionalEnvNumber(env, ["TAH_AVAILABLE_MEMORY_MB"]),
    availableNetworkMbps: optionalEnvNumber(env, ["TAH_AVAILABLE_NETWORK_MBPS"]),
    measuredDatabaseWritesPerSecond: optionalEnvNumber(env, [
      "TAH_MEASURED_DATABASE_WRITES_PER_SECOND",
    ]),
    tunnelMode: detectTunnelMode(env),
    soakTestHours: optionalEnvNumber(env, ["TAH_SOAK_TEST_HOURS"]),
    requiredSoakTestHours: optionalEnvNumber(env, ["TAH_REQUIRED_SOAK_TEST_HOURS"]),
  };

  return {
    ...Object.fromEntries(
      Object.entries(fromEnvironment).filter(([, value]) => value !== undefined),
    ),
    ...overrides,
  };
}

export function renderCapacityReport(plan: CapacityPlan): string {
  const lines = [
    "Traffic Armour 500-campaign capacity preflight",
    `Managed queue: ${plan.managedQueueReady ? "PASS" : "FAIL"}`,
    `True browser parallelism: ${plan.browser.trueParallelReady ? "PASS" : "FAIL"} (${plan.browser.admittedConcurrentCampaigns}/${plan.input.campaigns} admitted)`,
    `Fleet newest-value stability: ${plan.fleet.stableForNewestValue ? "PASS" : "FAIL"}`,
    `Fleet safety headroom: ${plan.fleet.safetyHeadroomReady ? "PASS" : "FAIL"} (${plan.fleet.configuredShardCount}/${plan.fleet.recommendedShardCount} shards)`,
    `Every-capture continuity: ${plan.fleet.everyCaptureMathematicallyPossible ? "PASS" : "FAIL"}`,
    `Production latest-value readiness: ${plan.productionReadyForLatestValue ? "PASS" : "FAIL"}`,
    `Production every-capture readiness: ${plan.productionReadyForEveryCapture ? "PASS" : "FAIL"}`,
    "",
    ...plan.checks.map(
      (item) => `[${item.status.toUpperCase()}] ${item.label}: ${item.detail}`,
    ),
  ];
  return lines.join("\n");
}
