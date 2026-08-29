import type { RawRequestRecord, Scenario } from '@tah/contracts';
import { fireWithJa3 } from './ja3.js';

export interface RedirectResolutionHop {
  from: string;
  to: string;
  status: number;
  at: string;
}

export interface RedirectFirstResult {
  outcome: 'captured' | 'browser_required';
  reason: string;
  startedAt: string;
  totalMs: number;
  finalUrl?: string;
  events: RawRequestRecord[];
  redirects: RedirectResolutionHop[];
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function hasExactQuery(raw: string): boolean {
  const queryStart = raw.indexOf('?');
  if (queryStart < 0) return false;
  const fragmentStart = raw.indexOf('#', queryStart + 1);
  const queryEnd = fragmentStart >= 0 ? fragmentStart : raw.length;
  return queryEnd > queryStart + 1;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === '0.0.0.0'
    || host === '::1'
    || /^f[cd][0-9a-f]{2}:/i.test(host)
    || host.startsWith('fe80:')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function parseRefreshLocation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/i);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function resolveLocationPreservingQuery(rawLocation: string, current: URL): { requestUrl: URL; capturedUrl: string } | undefined {
  const raw = rawLocation.trim();
  if (!raw) return undefined;
  try {
    const requestUrl = new URL(raw, current);
    if (requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'https:') return undefined;
    const absoluteInHeader = /^https?:\/\//i.test(raw);
    return {
      requestUrl,
      capturedUrl: absoluteInHeader ? raw : requestUrl.toString(),
    };
  } catch {
    return undefined;
  }
}

function browserRequired(
  reason: string,
  startedAt: string,
  startedMs: number,
  events: RawRequestRecord[],
  redirects: RedirectResolutionHop[],
): RedirectFirstResult {
  return {
    outcome: 'browser_required',
    reason,
    startedAt,
    totalMs: Date.now() - startedMs,
    events,
    redirects,
  };
}

/**
 * Resolve server-side redirects using the campaign's existing residential
 * proxy session. It never parses or rebuilds a captured query string. HTML,
 * JavaScript, challenges, unsafe destinations, and ambiguous responses are
 * deliberately delegated to the browser tier.
 */
export async function resolveRedirectFirst(
  scenario: Scenario,
  proxyUrl: URL,
  env: Record<string, string | undefined> = process.env,
): Promise<RedirectFirstResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const events: RawRequestRecord[] = [];
  const redirects: RedirectResolutionHop[] = [];
  const maxHops = boundedInteger(env.TAH_REDIRECT_MAX_HOPS, 10, 1, 25);
  const hopTimeoutMs = boundedInteger(env.TAH_REDIRECT_HOP_TIMEOUT_MS, 10_000, 1_000, 60_000);
  const totalTimeoutMs = boundedInteger(env.TAH_REDIRECT_TOTAL_TIMEOUT_MS, 20_000, 1_000, 120_000);
  const userAgent = env.TAH_REDIRECT_RESOLVER_USER_AGENT
    ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const followExternal = scenario.session?.follow_external_redirects === true;
  const proxy = proxyUrl.protocol === 'direct:' ? null : proxyUrl;
  let current: URL;

  try {
    current = new URL(scenario.seed_url);
  } catch {
    return browserRequired('invalid_seed_url', startedAt, startedMs, events, redirects);
  }

  const seedOrigin = current.origin;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (Date.now() - startedMs >= totalTimeoutMs) {
      return browserRequired('redirect_total_timeout', startedAt, startedMs, events, redirects);
    }

    const hopStarted = Date.now();
    let response: Awaited<ReturnType<typeof fireWithJa3>>;
    try {
      response = await fireWithJa3(current, proxy, {
        headersOnly: true,
        maxBodyBytes: 0,
        timeoutMs: Math.min(hopTimeoutMs, totalTimeoutMs - (Date.now() - startedMs)),
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Upgrade-Insecure-Requests': '1',
        },
      });
    } catch {
      return browserRequired('redirect_request_failed', startedAt, startedMs, events, redirects);
    }

    const location = response.headers.location ?? parseRefreshLocation(response.headers.refresh);
    events.push({
      url: current.toString(),
      method: 'GET',
      status: response.status,
      time_ms: Date.now() - hopStarted,
      headers: response.headers,
      ta_signal: {
        main_document: 'true',
        capture_path: 'redirect-first',
        redirect_hop: String(hop),
        ...(location ? { redirect_to: location } : {}),
      },
    });

    if (response.status >= 300 && response.status < 400) {
      if (!location) {
        return browserRequired('redirect_without_location', startedAt, startedMs, events, redirects);
      }
      if (hop >= maxHops) {
        return browserRequired('redirect_hop_limit', startedAt, startedMs, events, redirects);
      }

      const resolved = resolveLocationPreservingQuery(location, current);
      if (!resolved) {
        return browserRequired('unsupported_redirect_location', startedAt, startedMs, events, redirects);
      }
      if (isPrivateHostname(resolved.requestUrl.hostname)) {
        return browserRequired('private_redirect_blocked', startedAt, startedMs, events, redirects);
      }

      const redirect: RedirectResolutionHop = {
        from: current.toString(),
        to: resolved.capturedUrl,
        status: response.status,
        at: new Date().toISOString(),
      };
      redirects.push(redirect);

      if (resolved.requestUrl.origin !== seedOrigin && !followExternal) {
        if (hasExactQuery(resolved.capturedUrl)) {
          return {
            outcome: 'captured',
            reason: 'external_redirect_query_captured',
            startedAt,
            totalMs: Date.now() - startedMs,
            finalUrl: resolved.capturedUrl,
            events,
            redirects,
          };
        }
        return browserRequired('external_redirect_requires_browser', startedAt, startedMs, events, redirects);
      }

      current = resolved.requestUrl;
      continue;
    }

    if (response.status >= 200 && response.status < 300 && redirects.length > 0) {
      const finalUrl = redirects.at(-1)?.to ?? current.toString();
      if (hasExactQuery(finalUrl)) {
        return {
          outcome: 'captured',
          reason: 'redirect_chain_resolved',
          startedAt,
          totalMs: Date.now() - startedMs,
          finalUrl,
          events,
          redirects,
        };
      }
    }

    return browserRequired(
      response.status === 403 || response.status === 429
        ? 'challenge_or_rate_limit'
        : 'browser_navigation_required',
      startedAt,
      startedMs,
      events,
      redirects,
    );
  }

  return browserRequired('redirect_hop_limit', startedAt, startedMs, events, redirects);
}
