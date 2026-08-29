export interface JourneyResourcePolicy {
  blockHeavyResources: boolean;
  blockedResourceTypes: ReadonlySet<string>;
  bodyResourceTypes: ReadonlySet<string>;
  maxResponseBodyBytes: number;
  maxEventRecords: number;
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function csvSet(value: string | undefined, fallback: string): ReadonlySet<string> {
  return new Set((value ?? fallback)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean));
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function resourcePolicyFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): JourneyResourcePolicy {
  return {
    blockHeavyResources: enabled(env.TAH_BLOCK_HEAVY_RESOURCES, true),
    blockedResourceTypes: csvSet(env.TAH_BLOCKED_RESOURCE_TYPES, 'image,media,font'),
    bodyResourceTypes: csvSet(env.TAH_BODY_CAPTURE_RESOURCE_TYPES, 'document,xhr,fetch'),
    maxResponseBodyBytes: boundedInteger(env.TAH_MAX_RESPONSE_BODY_BYTES, 65_536, 0, 2_000_000),
    maxEventRecords: boundedInteger(env.TAH_MAX_JOURNEY_EVENT_RECORDS, 200, 50, 5_000),
  };
}

export function shouldAbortResource(
  policy: JourneyResourcePolicy,
  resourceType: string,
  isNavigationRequest: boolean,
): boolean {
  if (!policy.blockHeavyResources || isNavigationRequest || resourceType === 'document') return false;
  return policy.blockedResourceTypes.has(resourceType.toLowerCase());
}

export function shouldCaptureResponseBody(
  policy: JourneyResourcePolicy,
  resourceType: string,
): boolean {
  return policy.maxResponseBodyBytes > 0 && policy.bodyResourceTypes.has(resourceType.toLowerCase());
}

export function findExactSuffixUrl(candidates: Array<string | null | undefined>): string | undefined {
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const queryStart = raw.indexOf('?');
    const fragmentStart = queryStart >= 0 ? raw.indexOf('#', queryStart + 1) : -1;
    const queryEnd = fragmentStart >= 0 ? fragmentStart : raw.length;
    if (queryStart < 0 || queryStart >= queryEnd - 1) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw;
    } catch {
      // A malformed URL cannot be a verified landing URL.
    }
  }
  return undefined;
}
