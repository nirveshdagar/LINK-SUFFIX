import type { BrowserContext } from 'playwright';
import type { DeviceProfile } from '@tah/profiles';
import { parseRedirectCapturePolicy, redirectLocationForPolicy, evaluateCaptureResult, edgeStopForResponse,
  type Scenario, type RequestEvent, type RawRequestRecord } from '@tah/contracts';
import { createPublicEgressProxy, publicHttpUrl, withDeadline, ProxyResponseError } from '@tah/proxy';
import { verifyProxyEgressStability } from '@tah/tz';
import { templatesForProfile } from '@tah/ua';
import { acquireBrowserLease } from './browserPool.js';
import { acquireBrowserPermit } from './browserPermit.js';
import { isTopLevelNavigation } from './mainDocument.js';

/** Opt-in metadata capture. No merchant request, synthetic response or rendered-page claim. */
export async function* runRedirectCapture(scenario: Scenario, proxyUrl: URL, device: DeviceProfile,
  runtime: { signal?: AbortSignal } = {}): AsyncIterable<RequestEvent> {
  const policy = parseRedirectCapturePolicy(scenario.redirect_capture, scenario.seed_url);
  if (!policy || scenario.tier !== 'human' || (scenario as Scenario & { entry?: { mode?: string } }).entry?.mode === 'natural_click') {
    throw new Error('Redirect-only capture requires an explicit direct-entry browser policy');
  }
  if (runtime.signal?.aborted) throw new Error('Campaign journey aborted');
  if (scenario.proxy_mode !== 'sticky-residential') throw new Error('Redirect-only capture requires one stable proxy session');
  const start = Date.now();
  const egress = await withDeadline(verifyProxyEgressStability(proxyUrl), 30_000, runtime.signal);
  if (!egress.verified || !egress.ip || !egress.timezone) throw new Error('Redirect capture requires a verified residential exit and timezone');
  const templates = templatesForProfile(device.id);
  const template = templates[Math.floor(Math.random() * templates.length)]!;
  const engine = template.family.includes('safari') || ['iphone', 'ipad'].includes(template.family) ? 'webkit' : 'chromium';
  const permit = await acquireBrowserPermit({ timeoutMs: 30_000 });
  let lease: Awaited<ReturnType<typeof acquireBrowserLease>> | undefined;
  let guard: Awaited<ReturnType<typeof createPublicEgressProxy>> | undefined;
  let context: BrowserContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  let finalUrl = scenario.seed_url;
  let error: string | undefined;
  const events: RawRequestRecord[] = [];
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const stop = (message?: string) => {
    if (completed) return;
    completed = true;
    error = message;
    finish();
  };
  const abort = () => stop('Campaign journey aborted');
  try {
    if (runtime.signal?.aborted) throw new Error('Campaign journey aborted');
    lease = await acquireBrowserLease({ engine, headless: scenario.session?.headless ?? true, proxyUrl });
    guard = await createPublicEgressProxy(proxyUrl, {
      signal: runtime.signal, allowedOrigins: policy.navigation_origins,
      onUpstreamFailure: ({ hostname, error: failure }) => {
        if (completed || !policy.navigation_origins.some(origin => new URL(origin).hostname === hostname)) return;
        if (failure instanceof ProxyResponseError) {
          events.push({ url: 'https://' + hostname + '/', method: 'CONNECT', status: failure.status, time_ms: Date.now() - start,
            headers: { 'retry-after': failure.retryAfter, 'cf-ray': failure.rayId },
            ta_signal: { main_document: 'true', proxy_response: 'true' } });
        }
        stop('Upstream connection failed before redirect verification');
      },
    });
    context = await lease.browser.newContext({
      viewport: { width: device.viewport.w, height: device.viewport.h }, locale: device.locale,
      timezoneId: egress.timezone, proxy: guard.proxy, serviceWorkers: 'block', acceptDownloads: false,
    });
    runtime.signal?.addEventListener('abort', abort, { once: true });
    if (runtime.signal?.aborted) abort();
    context.on('close', () => { if (!completed) stop('Browser context closed before redirect verification'); });
    await context.route('**/*', async route => {
      try {
        const request = route.request();
        const url = publicHttpUrl(request.url());
        if (completed || !policy.navigation_origins.includes(url.origin)) {
          // This route is defense in depth. The guarded proxy also denies CONNECT
          // before any upstream socket can reach an excluded origin.
          await route.abort('blockedbyclient');
          return;
        }
        if (isTopLevelNavigation(request)) {
          const refusal = edgeStopForResponse({ url: request.url(), status: 0, headers: {} });
          if (refusal) {
            events.push({ url: request.url(), method: request.method(), status: 0, time_ms: Date.now() - start,
              headers: {}, ta_signal: { main_document: 'true', request_not_sent: 'true' } });
            stop(refusal.message);
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      } catch {
        stop('Redirect request was outside the approved routing policy');
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    context.on('response', response => {
      if (completed || !isTopLevelNavigation(response.request())) return;
      try {
        const request = response.request();
        const record: RawRequestRecord = { url: response.url(), method: request.method(), status: response.status(),
          time_ms: Date.now() - start, headers: response.headers(),
          ta_signal: { main_document: 'true', capture_path: 'browser-redirect-only',
            destination_visited: 'false', egress_guard: 'origin_allowlist', browser_identity: 'native', browser_engine: engine,
            ua_actual: request.headers()['user-agent'] ?? '' } };
        events.push(record);
        if (events.length > 32) { stop('Redirect hop limit exceeded'); return; }
        const refusal = edgeStopForResponse(record);
        if (refusal) { finalUrl = record.url; stop(refusal.message); return; }
        if (!policy.navigation_origins.includes(new URL(record.url).origin)) {
          stop('Unexpected response outside the approved tracking origins'); return;
        }
        const location = redirectLocationForPolicy(policy, record);
        if (!location) return;
        finalUrl = location;
        const decision = evaluateCaptureResult({ final_landing_url: location, final_verdict: 'unsure',
          redirect_capture: policy, events });
        stop(decision.accepted ? undefined : decision.message);
      } catch { stop('Unable to validate redirect response evidence'); }
    });
    const page = await context.newPage();
    timer = setTimeout(() => stop('Approved affiliate redirect was not received before the deadline'), 60_000);
    if (!completed) {
      // A denied merchant navigation may reject goto before its preceding response
      // event arrives. Wait for bounded response evidence, never retry the merchant.
      void page.goto(scenario.seed_url, { waitUntil: 'commit', timeout: 60_000 }).catch(() => undefined);
    }
    await finished;
  } finally {
    if (timer) clearTimeout(timer);
    runtime.signal?.removeEventListener('abort', abort);
    const cleanup = await Promise.allSettled([context?.close(), guard?.close()]);
    lease?.release();
    permit.release();
    if (cleanup.some(item => item.status === 'rejected')) throw new Error('Redirect capture cleanup failed; proxy replacement is disabled');
  }
  if (runtime.signal?.aborted) throw new Error('Campaign journey aborted');
  yield {
    scenario_id: scenario.id, repeat_index: 0, tier: 'human', geo_requested: scenario.geo,
    geo_resolved: { ip: egress.ip, country: egress.country ?? scenario.geo.country, state: egress.state, city: egress.city,
      timezone: egress.timezone, asn: egress.asn, organization: egress.organization, isp: egress.isp,
      intelligence_provider: egress.provider, observed_at: new Date(start).toISOString(),
      confidence: 'stable_session', verified: egress.verified },
    proxy_mode: scenario.proxy_mode, started_at: new Date(start).toISOString(), final_landing_url: finalUrl,
    redirect_capture: policy, events, final_verdict: error ? 'error' : 'unsure',
    timing: { total_ms: Date.now() - start, pages_visited: 0 }, error,
  };
}
