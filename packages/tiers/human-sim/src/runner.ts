import type { BrowserContext } from 'playwright';
import { isTopLevelNavigation } from './mainDocument.js';
import { edgeStopForResponse, evaluateCaptureResult, type CaptureRejection } from '@tah/contracts';
import { createPublicEgressProxy, ProxyTransportError, ProxyResponseError } from '@tah/proxy';
import { templatesForProfile } from '@tah/ua';
import { resolveProxyEgress, verifyProxyEgressStability, resetTzCache, tzForGeo, commonTzForLocale, type Geo } from '@tah/tz';
import { bezierMove, humanClick } from './behavior/mouse.js';
import { humanScroll } from './behavior/scroll.js';
import { TelemetryRecorder, type BrowserFrameEvent, type PageSummary } from '@tah/telemetry';
import { logNormalTimeMs } from './behavior/timing.js';
import { extractInternalLinks, pickNextUrl } from './journey.js';
import { detectChallenge, pauseForIntervention, type DetectedChallenge, type RedirectHop } from './challenge.js';
import { acquireBrowserPermit } from './browserPermit.js';
import { acquireBrowserLease } from './browserPool.js';
import {
  findExactSuffixUrl,
  resourcePolicyFromEnvironment,
  shouldAbortResource,
  shouldCaptureResponseBody,
} from './resourcePolicy.js';
import path from 'node:path';
import type { Scenario, RequestEvent, RawRequestRecord } from '@tah/contracts';
import type { DeviceProfile } from '@tah/profiles';

const FALLBACK_LINKS = ['/', '/pricing', '/about', '/contact'] as const;
const configuredNavigationTimeout = Number(process.env.TAH_NAVIGATION_TIMEOUT_MS ?? 30_000);
const NAVIGATION_TIMEOUT_MS = Number.isFinite(configuredNavigationTimeout)
  ? Math.min(120_000, Math.max(8_000, configuredNavigationTimeout))
  : 30_000;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char] ?? char);
const LOCALE_BY_COUNTRY: Record<string, string> = {
  AR: 'es-AR', AT: 'de-AT', AU: 'en-AU', BE: 'nl-BE', BR: 'pt-BR', CA: 'en-CA', CH: 'de-CH', CL: 'es-CL', CN: 'zh-CN', CO: 'es-CO', CZ: 'cs-CZ', DE: 'de-DE', DK: 'da-DK', EG: 'ar-EG', ES: 'es-ES', FI: 'fi-FI', FR: 'fr-FR', GB: 'en-GB', GR: 'el-GR', HK: 'zh-HK', HU: 'hu-HU', ID: 'id-ID', IE: 'en-IE', IL: 'he-IL', IN: 'en-IN', IT: 'it-IT', JP: 'ja-JP', KR: 'ko-KR', MX: 'es-MX', MY: 'ms-MY', NL: 'nl-NL', NO: 'nb-NO', NZ: 'en-NZ', PH: 'en-PH', PK: 'en-PK', PL: 'pl-PL', PT: 'pt-PT', RO: 'ro-RO', RU: 'ru-RU', SA: 'ar-SA', SE: 'sv-SE', SG: 'en-SG', TH: 'th-TH', TR: 'tr-TR', TW: 'zh-TW', UA: 'uk-UA', US: 'en-US', VN: 'vi-VN', ZA: 'en-ZA',
};
const affiliateClickIdFromUrl = (rawUrl: string): string | undefined => {
  try {
    const value = new URL(rawUrl).searchParams.get('irclickid')?.trim();
    return value ? value.slice(0, 512) : undefined;
  } catch { return undefined; }
};


function boundedDeadlineMs(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback;
}

const RESPONSE_READ_DEADLINE_MS = boundedDeadlineMs(
  process.env.TAH_RESPONSE_READ_DEADLINE_MS,
  5_000,
  1_000,
  30_000,
);
const RESPONSE_TASK_SETTLE_DEADLINE_MS = boundedDeadlineMs(
  process.env.TAH_RESPONSE_TASK_SETTLE_DEADLINE_MS,
  12_000,
  2_000,
  60_000,
);

class BrowserResponseDeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(label + " exceeded its " + timeoutMs + "ms deadline");
    this.name = "BrowserResponseDeadlineError";
  }
}

async function withBrowserResponseDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserResponseDeadlineError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleResponseTasks(responseTasks: Iterable<Promise<unknown>>): Promise<void> {
  const pending = Array.from(responseTasks);
  if (pending.length === 0) return;
  try {
    await withBrowserResponseDeadline(
      Promise.allSettled(pending).then(() => undefined),
      RESPONSE_TASK_SETTLE_DEADLINE_MS,
      "Browser response processing",
    );
  } catch (error) {
    if (!(error instanceof BrowserResponseDeadlineError)) throw error;
  }
}
async function readBoundedResponseBody(response: { allHeaders?: () => Promise<Record<string,string>>; headers?: () => Record<string,string>; body: () => Promise<Buffer> }, maxBytes: number) {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const headers = response.allHeaders ? await withBrowserResponseDeadline(response.allHeaders(), RESPONSE_READ_DEADLINE_MS, "Response headers") : response.headers ? response.headers() : {};
  const rawLength = headers["content-length"];
  const declaredLength = rawLength === undefined ? Number.NaN : Number(rawLength);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) return Buffer.alloc(0);
  const body = await withBrowserResponseDeadline(response.body(), RESPONSE_READ_DEADLINE_MS, "Response body");
  return body.length <= maxBytes ? body : body.subarray(0, maxBytes);
}
export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  device: DeviceProfile,
): AsyncIterable<RequestEvent> {
  const runtime = (scenario as Scenario & { __tahRuntime?: { signal?: AbortSignal; telemetryDir?: string; challengeDir?: string } }).__tahRuntime;
  if (runtime?.signal?.aborted) throw new Error('Campaign journey aborted');
  resetTzCache();
  const templates = templatesForProfile(device.id);
  const template = templates[Math.floor(Math.random() * templates.length)]!;
  const useWebKit = template.family.includes('safari') || template.family === 'iphone' || template.family === 'ipad';
  let tzLookupFailed = false;
  let timezone = commonTzForLocale(device.locale);
  const egress = scenario.proxy_mode === 'sticky-residential'
    ? await verifyProxyEgressStability(proxyUrl)
    : await resolveProxyEgress(proxyUrl);
  const egressObservedAt = new Date().toISOString();
  if (egress.ip && egress.timezone) {
    timezone = egress.timezone;
  } else {
    tzLookupFailed = true;
    const geoTz = tzForGeo(scenario.geo as Geo);
    if (geoTz) timezone = geoTz;
  }
  if (scenario.fingerprint?.strict_timezone !== false && tzLookupFailed) {
    throw new Error('Unable to resolve timezone from the residential egress IP');
  }
  const browserPermit = await acquireBrowserPermit();
  let browserLease: Awaited<ReturnType<typeof acquireBrowserLease>> | undefined;
  let ctx: BrowserContext | undefined;
  let guardedEgress: Awaited<ReturnType<typeof createPublicEgressProxy>> | undefined;
  const abortContext = () => { void ctx?.close().catch(() => undefined); };
  try {
    browserLease = await acquireBrowserLease({
      engine: useWebKit ? 'webkit' : 'chromium',
      headless: scenario.session?.headless ?? true,
      proxyUrl,
    });
  } catch (error) {
    browserPermit.release();
    throw error;
  }
  try {

  const session = scenario.session ?? { pages: { min: 6, max: 10 } };
  const resourcePolicy = resourcePolicyFromEnvironment();
  const target = scenario.continuous ? 1 : (() => {
    const min = session.pages?.min ?? 6;
    const max = session.pages?.max ?? 10;
    return min + Math.floor(Math.random() * (max - min + 1));
  })();
  const visitCounts = new Map<string, number>();
  const pages: string[] = [];
  const allEvents: RawRequestRecord[] = [];
  const behaviorSummaries: PageSummary[] = [];
  const start = Date.now();
  let mouseMoves = 0;
  let scrollPulses = 0;
  let error: string | undefined;
  let suffixCaptured = false;
  let capturedLandingUrl: string | undefined;
  let challengeResult: RequestEvent['challenge'];
  const locale = LOCALE_BY_COUNTRY[String(egress.country ?? scenario.geo.country).toUpperCase()] ?? device.locale ?? 'en-US';
  const edgeState: { rejection?: CaptureRejection; record?: RawRequestRecord } = {};
  let activeDocumentHost = new URL(scenario.seed_url).hostname;
  let upstreamTransportError: ProxyTransportError | undefined;
  let destinationResponded = false;
  let transportStopped = false;
  const rememberJourneyFailure = (cause: unknown) => {
    if (runtime?.signal?.aborted) throw cause;
    error = edgeState.rejection ? 'Target rejected capture: ' + edgeState.rejection.code
      : upstreamTransportError && !destinationResponded ? upstreamTransportError.message
      : cause instanceof Error ? cause.message : String(cause);
    capturedLandingUrl = undefined;
    suffixCaptured = false;
  };
  const stopAtEdge = (record: RawRequestRecord): boolean => {
    const rejection = edgeStopForResponse(record);
    if (!rejection) return false;
    if (!edgeState.rejection) {
      edgeState.rejection = rejection;
      edgeState.record = record;
      allEvents.push(record);
      error = 'Target rejected capture: ' + rejection.code;
      capturedLandingUrl = undefined;
      suffixCaptured = false;
      // Close the entire context, including popups and pending subresources.
      void ctx?.close().catch(() => undefined);
    }
    return true;
  };
  guardedEgress = await createPublicEgressProxy(proxyUrl, {
    signal: runtime?.signal,
    onUpstreamFailure: ({ hostname, error: failure }) => {
      if (hostname !== activeDocumentHost) return;
      if (failure instanceof ProxyTransportError && !destinationResponded) upstreamTransportError = failure;
      if (failure instanceof ProxyResponseError) stopAtEdge({
        url: 'https://' + hostname + '/', method: 'CONNECT', status: failure.status,
        time_ms: Date.now() - start, headers: { 'retry-after': failure.retryAfter, 'cf-ray': failure.rayId },
        ta_signal: { main_document: 'true', proxy_response: 'true' },
      });
    },
  });
  ctx = await browserLease.browser.newContext({
    // Keep the browser's native identity, including automation indicators and
    // client hints. Device profiles control layout, not a forged browser version.
    viewport: { width: device.viewport.w, height: device.viewport.h },
    locale,
    timezoneId: timezone,
    proxy: guardedEgress.proxy,
    serviceWorkers: 'block',
  });
  runtime?.signal?.addEventListener('abort', abortContext, { once: true });
  let activeTelemetry: TelemetryRecorder | null = null;
  await ctx.exposeBinding('__tahTelemetry', (_source, payload: { frameTimestamp?: number; wallTime?: number; events?: BrowserFrameEvent[] }) => {
    if (activeTelemetry && Array.isArray(payload?.events)) {
      activeTelemetry.recordFrame(Number(payload.frameTimestamp), Number(payload.wallTime), payload.events);
    }
  });
  await ctx.addInitScript(() => {
    const pending: Array<Record<string, unknown>> = [];
    let scheduled = false;
    const selector = (target: EventTarget | null) => {
      const el = target instanceof Element ? target : null;
      if (!el) return '';
      return [el.tagName.toLowerCase(), el.id ? `#${el.id}` : '', el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : ''].join('').slice(0, 160);
    };
    const enqueue = (event: Record<string, unknown>) => {
      pending.push(event);
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame((frameTimestamp) => {
        scheduled = false;
        const events = pending.splice(0, 500);
        void (globalThis as any).__tahTelemetry({ frameTimestamp, wallTime: Date.now(), events });
      });
    };
    addEventListener('pointermove', (event) => enqueue({ type: 'mouse_move', x: event.clientX, y: event.clientY }), { passive: true, capture: true });
    addEventListener('click', (event) => enqueue({ type: 'click', x: event.clientX, y: event.clientY, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', target: selector(event.target) }), { passive: true, capture: true });
    addEventListener('wheel', (event) => enqueue({ type: 'scroll', deltaY: event.deltaY, x: event.clientX, y: event.clientY }), { passive: true, capture: true });
    addEventListener('keydown', (event) => enqueue({ type: 'keypress', keyCategory: event.key.length === 1 ? 'printable' : event.key.toLowerCase().slice(0, 32) }), { passive: true, capture: true });
    addEventListener('focus', () => enqueue({ type: 'focus', focused: true }), { passive: true, capture: true });
    addEventListener('blur', () => enqueue({ type: 'focus', focused: false }), { passive: true, capture: true });
    addEventListener('pointerover', (event) => enqueue({ type: 'hover', x: event.clientX, y: event.clientY, target: selector(event.target) }), { passive: true, capture: true });
  });
  const page = await ctx.newPage();
  const responseTasks = new Set<Promise<void>>();
  const requestStarted = new WeakMap<object, number>();
  ctx.on('request', (request) => {
    requestStarted.set(request, Date.now());
    try {
      if (isTopLevelNavigation(request)) activeDocumentHost = new URL(request.url()).hostname;
    } catch { /* Detached frames cannot choose a replacement route. */ }
  });
  const redirectState: { current: { from: string; to: string; status: number } | null } = { current: null };
  const redirectChain: RedirectHop[] = [];
  ctx.on('response', (res) => {
    if (edgeState.rejection || transportStopped) return;
    const responseRequest = res.request();
    const mainResponse = isTopLevelNavigation(responseRequest);
    if (mainResponse) {
      const record: RawRequestRecord = { url: res.url(), method: responseRequest.method(), status: res.status(),
        time_ms: Date.now() - start, headers: res.headers(), ta_signal: { main_document: 'true' } };
      if (stopAtEdge(record)) return;
      if (upstreamTransportError && !destinationResponded && res.status() === 502 && new URL(res.url()).hostname === activeDocumentHost) {
        record.ta_signal.proxy_transport_failure = upstreamTransportError.transportCode;
        allEvents.push(record);
        error = upstreamTransportError.message;
        transportStopped = true;
        void ctx?.close().catch(() => undefined);
        return;
      }
      destinationResponded = true;
    }
    const location = res.headers()['location'];
    if (res.status() >= 300 && res.status() < 400 && location) {
      try {
        const destination = new URL(location, res.url());
        redirectChain.push({
          from: res.url(),
          to: destination.toString(),
          status: res.status(),
          at: new Date().toISOString(),
          affiliateClickId: affiliateClickIdFromUrl(destination.toString()) ?? affiliateClickIdFromUrl(res.url()),
        });
        if (destination.origin !== new URL(scenario.seed_url).origin) {
          redirectState.current = { from: res.url(), to: destination.toString(), status: res.status() };
        }
      } catch { /* malformed Location remains ordinary response evidence */ }
    }
    if (allEvents.length + responseTasks.size >= resourcePolicy.maxEventRecords) return;
    const task = (async () => {
      const request = res.request();
      const requestStart = requestStarted.get(request) ?? start;
      let snippet = '';
      try {
        const declared = Number(res.headers()['content-length'] ?? 0);
        const buf = shouldCaptureResponseBody(resourcePolicy, request.resourceType()) && declared <= resourcePolicy.maxResponseBodyBytes
          ? await readBoundedResponseBody(res, resourcePolicy.maxResponseBodyBytes)
          : Buffer.alloc(0);
        snippet = buf.subarray(0, 65536).toString('utf8');
      } catch {
        // Streaming responses may not expose a body.
      }
      allEvents.push({
        url: res.url(),
        method: request.method(),
        status: Number(res.headers()['x-tah-original-status']) || res.status(),
        time_ms: Date.now() - requestStart,
        headers: res.headers(),
        ta_signal: {
          ua_actual: request.headers()['user-agent'] ?? '',
          template_id: useWebKit ? 'native-webkit' : 'native-chromium',
          timezone,
          tz_lookup_failed: tzLookupFailed ? 'true' : 'false',
          main_document: mainResponse ? 'true' : 'false',
          ...(redirectState.current ? {
            redirect_external: 'true',
            redirect_to: redirectState.current.to,
          } : {}),
        },
        body_snippet: snippet,
      });
    })();
    responseTasks.add(task);
    void task.then(() => responseTasks.delete(task), () => responseTasks.delete(task));
  });
  await ctx.route('**/*', async (route) => {
    const request = route.request();
    if (edgeState.rejection || transportStopped) { await route.abort('blockedbyclient').catch(() => undefined); return; }
    if (isTopLevelNavigation(request) && stopAtEdge({ url: request.url(), method: request.method(),
      status: 0, time_ms: Date.now() - start, headers: {}, ta_signal: { main_document: 'true', request_not_sent: 'true' } })) {
      await route.abort('blockedbyclient').catch(() => undefined); return;
    }
    // Abort challenge-only iframe navigation without claiming a top-level refusal.
    if (request.isNavigationRequest() && !isTopLevelNavigation(request)
      && edgeStopForResponse({ url: request.url(), status: 0, headers: {} })) {
      await route.abort('blockedbyclient').catch(() => undefined); return;
    }
    if (shouldAbortResource(resourcePolicy, request.resourceType(), request.isNavigationRequest())) {
      await route.abort('blockedbyclient');
      return;
    }
    if (request.isNavigationRequest() || request.resourceType() === 'document') {
      try {
        const requestedUrl = new URL(request.url());
        const seedUrl = new URL(scenario.seed_url);
        if (requestedUrl.origin !== seedUrl.origin) {
          redirectState.current ??= {
            from: seedUrl.toString(),
            to: requestedUrl.toString(),
            status: 302,
          };
          const hostname = requestedUrl.hostname.toLowerCase();
          const privateDestination = hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
          const mayFollow = session.follow_external_redirects === true && ['http:', 'https:'].includes(requestedUrl.protocol) && !privateDestination;
          if (!mayFollow) {
            await route.abort('blockedbyclient');
            return;
          }
        }
      } catch { /* let Chromium handle malformed request URLs */ }
    }
    await route.continue();
  });

  // humanClick was here as a no-op reference; the journey is link-driven
  // and we removed the import. Re-import only when journey starts clicking
  // CTAs (then wire `page.on(...)` → humanClick).

  let current = new URL(scenario.seed_url);
  try {
  for (let p = 0; p < target; p++) {
    if (Boolean(edgeState.rejection) || transportStopped) break;
    const telemetry = new TelemetryRecorder(current.toString());
    activeTelemetry = telemetry;
    visitCounts.set(current.toString(), (visitCounts.get(current.toString()) ?? 0) + 1);
    // Record response headers before waiting for the page to finish loading.
    // Refused or challenged responses still stop the journey immediately.
    try {
      await page.goto(current.toString(), { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(10_000, NAVIGATION_TIMEOUT_MS) }).catch(() => undefined);
      pages.push(current.toString());
    } catch (cause) {
      if (edgeState.rejection) { error = 'Target rejected capture: ' + edgeState.rejection.code; break; }
      if (upstreamTransportError && !destinationResponded) { error = upstreamTransportError.message; transportStopped = true; break; }
      const externalRedirect = redirectState.current;
      if (externalRedirect) {
        pages.push(current.toString());
        if (scenario.session?.headless === false) {
          await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><title>External redirect recorded</title><style>body{margin:0;background:#07111f;color:#e8f0ff;font:16px/1.5 sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(720px,calc(100% - 48px));padding:36px;border:1px solid #27456d;border-radius:18px;background:#0d1a2d}small{color:#77a8e8;text-transform:uppercase;letter-spacing:.12em}h1{font-size:30px;margin:12px 0}code{display:block;padding:14px;margin-top:10px;background:#07111f;border-radius:9px;word-break:break-all;color:#9dc4ff}</style></head><body><main class="card"><small>Traffic Armour · Redirect captured</small><h1>The target did not return a page.</h1><p>HTTP ${externalRedirect.status} redirected this browser outside the tested domain. The destination was recorded but not followed.</p><code>${escapeHtml(externalRedirect.from)}</code><code>${escapeHtml(externalRedirect.to)}</code></main></body></html>`);
          await page.waitForTimeout(3_000);
        }
        break;
      }
      error = cause instanceof Error ? cause.message : String(cause);
      break;
    }
    await settleResponseTasks(responseTasks);
    if (edgeState.rejection || transportStopped) break;
    if (scenario.continuous) {
      const exactLandingUrl = findExactSuffixUrl([
        page.url(),
        redirectState.current?.to,
        redirectChain.at(-1)?.to,
      ]);
      if (exactLandingUrl) {
        suffixCaptured = true;
        capturedLandingUrl = exactLandingUrl;
        behaviorSummaries.push(telemetry.buildSummary(Date.now()));
        break;
      }
    }
    const detected: DetectedChallenge | null = await detectChallenge(page, allEvents);
    if (detected) {
      const handling = session.challenge_handling;
      let status: NonNullable<RequestEvent['challenge']>['status'] = 'pending';
      let challengeId: string | undefined;
      if (handling?.enabled) {
        const outcome = await pauseForIntervention({
          page,
          challenge: detected,
          redirects: redirectChain,
          timeoutSeconds: Math.min(3600, Math.max(30, handling.timeout_seconds ?? 300)),
          persistent: handling.persistent === true,
          onTimeout: handling.on_timeout ?? 'skip',
          directory: runtime?.challengeDir,
        });
        challengeId = outcome.id;
        status = outcome.action === 'resume' ? 'resolved' : outcome.action === 'skip' ? 'skipped' : outcome.action === 'stop' ? 'stopped' : 'timed_out';
      }
      challengeResult = { id: challengeId, vendor: detected.vendor, challenge_type: detected.challengeType, reference_id: detected.referenceId, status, redirects: redirectChain };
      const main = [...allEvents].reverse().find((event) => event.ta_signal.main_document === 'true') ?? allEvents.at(-1);
      if (main) {
        main.ta_signal.challenge_vendors = detected.vendor;
        main.ta_signal.challenge_type = detected.challengeType;
        if (detected.referenceId) main.ta_signal.challenge_reference_id = detected.referenceId;
        main.ta_signal.redirect_chain = JSON.stringify(redirectChain);
      }
      if (!handling?.enabled || status !== 'resolved') break;
    }
    if (edgeState.rejection || transportStopped) break;
    await humanScroll(page);
    await page.waitForTimeout(logNormalTimeMs() / 4);
    mouseMoves++;
    scrollPulses++;
    telemetry.recordScroll(120, 0, 0);
    try {
      const landed = new URL(page.url());
      if (['http:', 'https:'].includes(landed.protocol)) {
        current = landed;
        pages[pages.length - 1] = landed.toString();
      }
    } catch { /* retain the requested URL when the browser has no valid landing URL */ }
    if (p < target - 1) {
      const base = new URL(current.toString());
      const links = await extractInternalLinks(page, base);
      const internalProbability = scenario.session?.internal_link_probability ?? 0.8;
      let next: URL | null = Math.random() <= internalProbability ? pickNextUrl(links, visitCounts) : null;
      if (!next) {
        const fbIdx = (p + 1) % FALLBACK_LINKS.length;
        next = new URL(base.origin + FALLBACK_LINKS[fbIdx]!);
      }
      await bezierMove(page, { x: Math.random() * 400 + 200, y: Math.random() * 200 + 200 });
      try {
        const href = next.pathname + next.search + next.hash;
        await humanClick(page, `a[href=${JSON.stringify(href)}],a[href=${JSON.stringify(next.toString())}]`);
        await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
      } catch { /* direct navigation on the next loop remains the fallback */ }
      current = next;
    }
    // Flush only after the page interaction is complete so its final click
    // and frame are included in the page telemetry.
    const tdir = runtime?.telemetryDir ?? process.env.TAH_TELEMETRY_DIR;
    if (tdir) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(tdir, { recursive: true });
      telemetry.writeToFile(path.join(tdir, `run-${Date.now()}-page-${p}.jsonl`));
    }
    behaviorSummaries.push(telemetry.buildSummary(Date.now()));
  }
  } catch (cause) {
    rememberJourneyFailure(cause);
  }
  activeTelemetry = null;
  await settleResponseTasks(responseTasks);
  const behavior = behaviorSummaries.reduce((summary, pageSummary) => ({
    frame_count: summary.frame_count + pageSummary.frame_count,
    event_count: summary.event_count + pageSummary.event_count,
    mouse_move_count: summary.mouse_move_count + pageSummary.mouse_move_count,
    click_count: summary.click_count + pageSummary.click_count,
    scroll_count: summary.scroll_count + pageSummary.scroll_count,
    keypress_count: summary.keypress_count + pageSummary.keypress_count,
    duration_ms: summary.duration_ms + pageSummary.duration_ms,
    mouse_velocity_avg: summary.mouse_velocity_avg + pageSummary.mouse_velocity_avg,
    mouse_velocity_max: Math.max(summary.mouse_velocity_max, pageSummary.mouse_velocity_max),
  }), { frame_count: 0, event_count: 0, mouse_move_count: 0, click_count: 0, scroll_count: 0, keypress_count: 0, duration_ms: 0, mouse_velocity_avg: 0, mouse_velocity_max: 0 });
  if (behaviorSummaries.length) behavior.mouse_velocity_avg /= behaviorSummaries.length;
  for (const event of allEvents) {
    event.ta_signal.browser_identity = 'native';
    event.ta_signal.browser_engine = useWebKit ? 'webkit' : 'chromium';
    event.ta_signal.behavior_frames = String(behavior.frame_count);
    event.ta_signal.behavior_events = String(behavior.event_count);
  }
  try {
  if (scenario.continuous && !error && !edgeState.rejection && !transportStopped && (!challengeResult || challengeResult.status === 'resolved')) {
    const suffixDeadline = Date.now() + 2 * 60_000;
    while (Date.now() < suffixDeadline && !edgeState.rejection && !transportStopped) {
      const candidate = findExactSuffixUrl([
        page.url(),
        redirectState.current?.to,
        redirectChain.at(-1)?.to,
      ]);
      if (candidate) {
        suffixCaptured = true;
        capturedLandingUrl = candidate;
        break;
      }
      await page.waitForTimeout(500).catch(cause => { if (!edgeState.rejection && !transportStopped) throw cause; });
    }
    if (!suffixCaptured && !edgeState.rejection && !transportStopped) {
      error = 'Final URL suffix was not captured within 120 seconds';
    }
  } else if (!edgeState.rejection && !transportStopped && session.headless === false && (session.visible_hold_seconds ?? 0) > 0) {
    await page.waitForTimeout(Math.min(120, session.visible_hold_seconds ?? 0) * 1000);
  }
  } catch (cause) {
    rememberJourneyFailure(cause);
  }
  const finalLandingUrl = edgeState.record?.url ?? capturedLandingUrl ?? findExactSuffixUrl([
    page.url(),
    redirectState.current?.to,
    redirectChain.at(-1)?.to,
  ]) ?? page.url();
  const finalAffiliateId = affiliateClickIdFromUrl(finalLandingUrl);
  const affiliateHop = [...redirectChain].reverse().find((hop) => hop.affiliateClickId);
  const affiliateClickId = finalAffiliateId ?? affiliateHop?.affiliateClickId;
  const affiliateSourceUrl = finalAffiliateId ? finalLandingUrl : affiliateHop?.to;
  if (affiliateClickId && affiliateSourceUrl) {
    const main = [...allEvents].reverse().find((event) => event.ta_signal.main_document === 'true') ?? allEvents.at(-1);
    if (main) {
      main.ta_signal.affiliate_parameter = 'irclickid';
      main.ta_signal.affiliate_click_id = affiliateClickId;
      main.ta_signal.affiliate_source_url = affiliateSourceUrl;
    }
  }
  // Scheduler backoff begins after context and route cleanup.
  yield {
    scenario_id: scenario.id,
    repeat_index: 0,
    tier: 'human',
    geo_requested: scenario.geo,
    geo_resolved: egress.ip ? {
      ip: egress.ip,
      country: egress.country ?? scenario.geo.country,
      state: egress.state,
      city: egress.city,
      timezone: egress.timezone ?? undefined,
      asn: egress.asn,
      organization: egress.organization,
      isp: egress.isp,
      intelligence_provider: egress.provider,
      observed_at: egressObservedAt,
      confidence: scenario.proxy_mode === 'sticky-residential' ? 'stable_session' : 'observed_probe',
      verified: egress.verified,
    } : undefined,
    proxy_mode: scenario.proxy_mode,
    started_at: new Date(start).toISOString(),
    pages,
    final_landing_url: finalLandingUrl,
    events: allEvents,
    behavior,
    challenge: challengeResult,
    affiliate_attribution: affiliateClickId && affiliateSourceUrl ? {
      parameter: 'irclickid',
      click_id: affiliateClickId,
      source_url: affiliateSourceUrl,
      captured_at: new Date().toISOString(),
    } : undefined,
    final_verdict: error ? 'error' : challengeResult && challengeResult.status !== 'resolved' ? 'challenge' : 'unsure',
    timing: {
      total_ms: Date.now() - start,
      pages_visited: pages.length,
      mouse_moves: mouseMoves,
      scroll_pulses: scrollPulses,
    },
    error,
  };
  } finally {
    runtime?.signal?.removeEventListener('abort', abortContext);
    let cleanupFailed = false;
    await ctx?.close().catch(() => { cleanupFailed = browserLease?.browser.isConnected() === true; });
    await guardedEgress?.close().catch(() => { cleanupFailed = true; });
    ctx = undefined;
    browserLease?.release();
    browserPermit.release();
    if (cleanupFailed) throw new Error('Browser or route cleanup was not acknowledged; proxy replacement is disabled');
  }
}
