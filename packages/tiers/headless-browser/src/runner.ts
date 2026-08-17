import { chromium, type Browser } from 'playwright';
import { synthesizeUA, templatesForProfile } from '@tah/ua';
import { timeZoneFromIP, resetTzCache, tzForGeo, commonTzForLocale, type Geo } from '@tah/tz';
import { request } from 'undici';
import type { Scenario, RequestEvent } from '@tah/orchestrator';
import type { DeviceProfile } from '@tah/profiles';

const buffer = Buffer.from(''); // geoip2-lite expects a Buffer; pass empty (mock for tests).

async function probeEgressIP(proxyUrl: URL): Promise<string | null> {
  try {
    const res = await request('https://api.ipify.org?format=json', {
      dispatcher: new (await import('undici')).ProxyAgent({ uri: proxyUrl.toString() }),
    });
    const body = await res.body.json() as { ip?: string };
    return body.ip ?? null;
  } catch {
    return null;
  }
}

export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  device: DeviceProfile,
): AsyncIterable<RequestEvent> {
  resetTzCache();
  const browser: Browser = await chromium.launch({
    headless: true,
    args: [`--proxy-server=${proxyUrl.toString()}`],
  });

  let tzLookupFailed = false;
  let timezone = commonTzForLocale(device.locale);
  const egressIp = await probeEgressIP(proxyUrl);
  if (egressIp) {
    const tz = await timeZoneFromIP(egressIp, buffer);
    if (tz) timezone = tz; else tzLookupFailed = true;
  } else {
    tzLookupFailed = true;
    const geoTz = tzForGeo(scenario.geo as Geo);
    if (geoTz) timezone = geoTz;
  }

  const templates = templatesForProfile(device.id);
  const start = Date.now();
  const events: RequestEvent['events'] = [];
  let page: import('playwright').Page | null = null;
  let ctx: import('playwright').BrowserContext | null = null;
  let error: string | undefined;

  try {
    const template = templates[Math.floor(Math.random() * templates.length)]!;
    const fp = synthesizeUA(template, { timezone });
    ctx = await browser.newContext({
      userAgent: fp.ua,
      viewport: { width: fp.fingerprint.viewport.w, height: fp.fingerprint.viewport.h },
      deviceScaleFactor: fp.fingerprint.viewport.dpr,
      locale: fp.fingerprint.locale,
      timezoneId: fp.fingerprint.timezone,
      extraHTTPHeaders: { 'Accept-Language': fp.fingerprint.languages.join(',') },
      proxy: { server: proxyUrl.toString() },
    });
    page = await ctx.newPage();
    page.on('response', async (res) => {
      const t = Date.now();
      try { await res.body(); } catch { /* ignore */ }
      events.push({
        url: res.url(), method: res.request().method(), status: res.status(),
        time_ms: Date.now() - t, headers: res.headers(), ta_signal: {
          ua_actual: fp.ua,
          template_id: fp.templateId,
          timezone: fp.fingerprint.timezone,
          tz_lookup_failed: tzLookupFailed ? 'true' : 'false',
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