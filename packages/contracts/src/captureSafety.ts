import { parseRedirectCapturePolicy, redirectLocationForPolicy } from './redirectCapture.js';

export type CaptureDiagnostics = {
  hostname?: string;
  httpStatus?: number;
  rayId?: string;
  retryAfterMs?: number;
};
export type CaptureRejection = {
  accepted: false; code: string; message: string;
  diagnostics?: CaptureDiagnostics;
  retry?: { notBefore: number; delayMs: number; consecutiveBlocks: number };
};
export type CaptureDecision = CaptureRejection | {
  accepted: true; finalUrl: string; suffix: string;
  evidence: 'document-response' | 'redirect-location' | 'redirect-only';
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function deliverySuffixIssue(value: unknown): string | null {
  if (typeof value !== 'string') return 'Invalid final URL suffix';
  // Inspect decoded fields, but never reserialize or invent captured bytes.
  let incompleteIdentifier: string | undefined;
  for (const [key, field] of new URLSearchParams(value)) {
    if (/^(?:__cf_chl(?:_|$)|cf_chl_(?:prog|seq)$)/i.test(key)) {
      return 'Invalid final URL suffix: Cloudflare challenge parameters cannot be delivered';
    }
    // These are click identifiers, unlike optional sharedid, UTM or reward fields.
    if (/^(?:irclickid|im_ref)$/i.test(key) && field.trim().length === 0) {
      incompleteIdentifier = key.toLowerCase();
    }
  }
  return incompleteIdentifier
    ? 'Invalid final URL suffix: empty tracking identifier ' + incompleteIdentifier + '; preserve the last valid suffix'
    : null;
}

export function assertDeliverableSuffix(value: unknown): asserts value is string {
  const issue = deliverySuffixIssue(value);
  if (issue) throw new Error(issue);
}

export function captureUrlIssue(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Invalid final landing URL';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return 'Invalid final landing URL protocol';
    if (/^\/cdn-cgi\/(?:challenge-platform(?:\/|$)|challenge(?:\/|$))/i.test(url.pathname)) {
      return 'Cloudflare challenge page is not a destination';
    }
    return deliverySuffixIssue(url.search.slice(1));
  } catch { return 'Invalid final landing URL'; }
}

function header(headers: unknown, name: string): string {
  const entry = Object.entries(record(headers)).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1]).trim() : '';
}

function documentUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try { const url = new URL(raw); url.hash = ''; return url.href; } catch { return undefined; }
}

function captureDiagnostics(main: Record<string, any> | undefined, finalUrl: unknown): CaptureDiagnostics {
  // Export only support identifiers, never URL queries, cookies or credentials.
  const diagnostics: CaptureDiagnostics = {};
  try {
    const raw = main?.url ?? finalUrl;
    if (typeof raw === 'string') {
      const url = new URL(raw);
      if (['http:', 'https:'].includes(url.protocol)) diagnostics.hostname = url.hostname.slice(0, 253);
    }
  } catch { /* Invalid addresses do not become diagnostic text. */ }
  const status = Number(main?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) diagnostics.httpStatus = status;
  const rayId = header(main?.headers, 'cf-ray');
  if (/^[a-f0-9]{16,32}(?:-[a-z0-9]{3,10})?$/i.test(rayId)) diagnostics.rayId = rayId;
  const retryAfter = header(main?.headers, 'retry-after');
  const now = Date.now();
  const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
  if (Number.isSafeInteger(delay) && delay >= 0 && now + delay <= 8_640_000_000_000_000) diagnostics.retryAfterMs = delay;
  return diagnostics;
}

// A refusal anywhere in the main-document chain is terminal for this attempt.
export function edgeStopForResponse(value: unknown): CaptureRejection | undefined {
  const response = record(value);
  const status = Number(response.status);
  const urlIssue = captureUrlIssue(response.url);
  let challengeLocation = false;
  try {
    const location = header(response.headers, 'location');
    challengeLocation = Boolean(location && /Cloudflare/.test(captureUrlIssue(new URL(location, response.url).href) ?? ''));
  } catch { /* A malformed Location is handled by normal redirect validation. */ }
  const cloudflare = /Cloudflare/.test(urlIssue ?? '') || challengeLocation || header(response.headers, 'cf-mitigated').toLowerCase() === 'challenge';
  if (!cloudflare && status !== 403 && status !== 429) return undefined;
  return { accepted: false, code: cloudflare ? 'cloudflare_challenge' : status === 429 ? 'rate_limited' : 'blocked_response',
    message: cloudflare ? 'Cloudflare challenge received; the journey was stopped' : status === 429 ? 'Rate limit received; the journey was stopped' : 'HTTP 403 received; the journey was stopped',
    diagnostics: captureDiagnostics(response, response.url) };
}

export function evaluateCaptureResult(value: unknown, options?: { redirectPolicy?: unknown }): CaptureDecision {
  const result = record(value);
  const finalUrl = result.final_landing_url;
  const events = Array.isArray(result.events) ? result.events : [];
  const documents = events.map(record).filter(event => record(event.ta_signal).main_document === 'true');
  const edgeStop = documents.map(edgeStopForResponse).find(Boolean);
  if (edgeStop) return edgeStop;
  const main = documents.at(-1);
  const diagnostics = captureDiagnostics(main, finalUrl);
  const reject = (code: string, message: string): CaptureRejection => ({
    accepted: false, code, message,
    ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
  });
  const urlIssue = captureUrlIssue(finalUrl);
  if (result.error && !/Cloudflare/i.test(urlIssue ?? '')) {
    const closed = /(?:target (?:page, context or browser|closed)|(?:page|context|browser).*(?:has been closed|was closed|is closed))/i.test(String(result.error));
    return reject(closed ? 'browser_closed' : 'capture_error', closed
      ? 'Browser closed before capture completed; no suffix was accepted'
      : 'The journey failed; no suffix was accepted');
  }
  if (urlIssue) return reject(/Cloudflare/i.test(urlIssue) ? 'cloudflare_challenge'
    : /empty tracking identifier/.test(urlIssue) ? 'empty_tracking_identifier' : 'invalid_url', urlIssue);
  if (main && header(main.headers, 'cf-mitigated').toLowerCase() === 'challenge') {
    return reject('cloudflare_challenge', 'Blocked by Cloudflare; no destination suffix was captured');
  }
  if (result.error) return reject('capture_error', 'The journey failed; no suffix was accepted');
  const challenge = record(result.challenge);
  if (challenge.status && challenge.status !== 'resolved') {
    return reject('unresolved_challenge', 'The destination challenge is unresolved; no suffix was accepted');
  }
  if (['block', 'blocked', 'challenge', 'error', 'deny', 'denied'].includes(String(result.final_verdict).toLowerCase())) {
    return reject('blocked_response', 'The journey was blocked; no suffix was accepted');
  }
  const question = finalUrl.indexOf('?');
  const fragment = finalUrl.indexOf('#');
  if (question < 0 || (fragment >= 0 && question > fragment)) return reject('missing_suffix', 'The final landing URL did not contain a suffix');
  const suffix = finalUrl.slice(question + 1, fragment < 0 ? undefined : fragment);
  if (!suffix) return reject('missing_suffix', 'The final landing URL did not contain a suffix');
  if (!main) return reject('unverified_destination', 'No main-document response confirms this destination');
  const status = Number(main.status);
  if (record(main.ta_signal).capture_path === 'browser-redirect-only' || result.redirect_capture != null || options?.redirectPolicy != null) {
    try {
      const policy = parseRedirectCapturePolicy(options ? options.redirectPolicy : result.redirect_capture);
      if (!policy || record(main.ta_signal).capture_path !== 'browser-redirect-only'
        || record(main.ta_signal).destination_visited !== 'false' || record(main.ta_signal).egress_guard !== 'origin_allowlist'
        || documents.some(event => !policy.navigation_origins.includes(new URL(event.url).origin) || captureUrlIssue(event.url))) {
        return reject('redirect_policy_mismatch', 'Redirect evidence does not match this run approved routing policy');
      }
      const location = redirectLocationForPolicy(policy, { url: main.url, status, headers: record(main.headers) });
      if (location !== finalUrl) return reject('unverified_destination', 'No approved affiliate Location confirms these exact destination bytes');
      const identifiers = new URL(finalUrl).searchParams.getAll(policy.required_parameter);
      if (identifiers.length !== 1 || !identifiers[0]?.trim()) {
        return reject('missing_tracking_identifier', 'The approved redirect requires exactly one nonempty tracking identifier');
      }
      return { accepted: true, finalUrl, suffix, evidence: 'redirect-only' };
    } catch { return reject('redirect_policy_mismatch', 'Redirect evidence requires a valid explicit routing policy'); }
  }
  if (Number.isInteger(status) && status >= 200 && status < 300 && documentUrl(main.url) === documentUrl(finalUrl)) {
    return { accepted: true, finalUrl, suffix, evidence: 'document-response' };
  }
  // Preserve the existing redirect-first path only with an actual HTTP Location.
  // This is redirect evidence, not a claim that the destination was rendered.
  const location = header(main.headers, 'location');
  if (record(main.ta_signal).capture_path === 'redirect-first'
    && [301, 302, 303, 307, 308].includes(status) && location
    && !captureUrlIssue(main.url)) {
    try {
      if (documentUrl(new URL(location, main.url).href) === documentUrl(finalUrl)) {
        return { accepted: true, finalUrl, suffix, evidence: 'redirect-location' };
      }
    } catch { /* Invalid redirect evidence fails closed. */ }
  }
  return reject('unverified_destination', 'A successful destination response or verified redirect is required before capture');
}
