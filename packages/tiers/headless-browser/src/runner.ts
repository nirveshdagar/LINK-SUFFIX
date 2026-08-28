import { chromium, webkit, type Browser } from 'playwright';
import { synthesizeUA, templatesForProfile, installFingerprintProfile } from '@tah/ua';
import { pickFingerprint } from '@tah/antidetect';
import { resolveProxyEgress, verifyProxyEgressStability, resetTzCache, tzForGeo, commonTzForLocale, type Geo } from '@tah/tz';
import type { Scenario, RequestEvent } from '@tah/contracts';
import type { DeviceProfile } from '@tah/profiles';


const TAH_MAX_RESPONSE_BODY_BYTES = Math.max(64_000, Number(process.env.TAH_MAX_RESPONSE_BODY_BYTES) || 2_000_000);
async function readBoundedResponseBody(response: { allHeaders?: () => Promise<Record<string,string>>; headers?: () => Record<string,string>; body: () => Promise<Buffer> }) {
  const headers = response.allHeaders ? await response.allHeaders() : response.headers ? response.headers() : {};
  const rawLength = headers["content-length"];
  const declaredLength = rawLength === undefined ? Number.NaN : Number(rawLength);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > TAH_MAX_RESPONSE_BODY_BYTES) return Buffer.alloc(0);
  const body = await response.body();
  return body.length <= TAH_MAX_RESPONSE_BODY_BYTES ? body : body.subarray(0, TAH_MAX_RESPONSE_BODY_BYTES);
}
export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  device: DeviceProfile,
): AsyncIterable<RequestEvent> {
  resetTzCache();
  const templates = templatesForProfile(device.id);
  const template = templates[Math.floor(Math.random() * templates.length)]!;
  const useWebKit = template.family.includes('safari') || template.family === 'iphone' || template.family === 'ipad';
  const browser: Browser = await (useWebKit ? webkit : chromium).launch({
    headless: true,
    ...(useWebKit ? {} : { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }),
  });

  let tzLookupFailed = false;
  let timezone = commonTzForLocale(device.locale);
  const egress = scenario.proxy_mode === 'sticky-residential'
    ? await verifyProxyEgressStability(proxyUrl)
    : await resolveProxyEgress(proxyUrl);
  if (egress.ip && egress.timezone) {
    timezone = egress.timezone;
  } else {
    tzLookupFailed = true;
    const geoTz = tzForGeo(scenario.geo as Geo);
    if (geoTz) timezone = geoTz;
  }
  if (scenario.fingerprint?.strict_timezone !== false && tzLookupFailed) {
    await browser.close();
    throw new Error('Unable to resolve timezone from the residential egress IP');
  }

  const start = Date.now();
  const events: RequestEvent['events'] = [];
  let page: import('playwright').Page | null = null;
  let ctx: import('playwright').BrowserContext | null = null;
  let error: string | undefined;

  try {
    const fp = synthesizeUA(template, { timezone });
    const curated = pickFingerprint(String((device as any).id ?? '').toLowerCase().includes('mac') ? 'mimic-gologin' : 'mimic-multilogin');
    const runtimeFp = { ...fp, fingerprint: { ...fp.fingerprint, viewport: { ...fp.fingerprint.viewport, w: curated.viewport.w, h: curated.viewport.h }, hardware: { cores: curated.hardware.cores, memoryGb: curated.hardware.memoryGb }, webgl: { vendor: curated.webglVendor, renderer: curated.webglRenderer } } };
    ctx = await browser.newContext({
      userAgent: runtimeFp.ua,
      viewport: { width: runtimeFp.fingerprint.viewport.w, height: runtimeFp.fingerprint.viewport.h },
      deviceScaleFactor: runtimeFp.fingerprint.viewport.dpr,
      locale: runtimeFp.fingerprint.locale,
      timezoneId: runtimeFp.fingerprint.timezone,
      extraHTTPHeaders: { 'Accept-Language': runtimeFp.fingerprint.languages.join(',') },
      ...(proxyUrl.protocol === 'direct:' ? {} : { proxy: {
        server: `${proxyUrl.protocol}//${proxyUrl.host}`,
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password),
      } }),
    });
    await installFingerprintProfile(ctx, runtimeFp, scenario.fingerprint?.mode);
    page = await ctx.newPage();
    const requestStarted = new WeakMap<object, number>();
    page.on('request', (request) => requestStarted.set(request, Date.now()));
    page.on('response', async (res) => {
      const request = res.request();
      const t = requestStarted.get(request) ?? start;
      let body_snippet = '';
      try {
        const limit = Math.max(0, Number(process.env.TAH_MAX_RESPONSE_BODY_BYTES ?? 262_144));
        const declared = Number(res.headers()['content-length'] ?? 0);
        const buf = declared > limit ? Buffer.alloc(0) : await readBoundedResponseBody(res);
        body_snippet = buf.toString('utf8', 0, 65536);
      } catch { /* ignore */ }
      events.push({
        url: res.url(), method: request.method(), status: res.status(),
        time_ms: Date.now() - t, headers: res.headers(), body_snippet, ta_signal: {
          ua_actual: fp.ua,
          template_id: fp.templateId,
          timezone: fp.fingerprint.timezone,
          tz_lookup_failed: tzLookupFailed ? 'true' : 'false',
          main_document: request.resourceType() === 'document' && request.frame() === page?.mainFrame() ? 'true' : 'false',
        },
      });
    });
    const resp = await page.goto(scenario.seed_url, { waitUntil: 'domcontentloaded' });
    error = resp ? undefined : 'navigation failed';
  } finally {
    if (page) await page.close();
    if (ctx) await ctx.close();
    await browser.close();
  }

  yield {
    scenario_id: scenario.id, repeat_index: 0, tier: 'headless',
    geo_requested: scenario.geo, proxy_mode: scenario.proxy_mode,
    started_at: new Date(start).toISOString(), events,
    final_verdict: 'unsure',
    timing: { total_ms: Date.now() - start, pages_visited: 1 },
    error,
  };
}
