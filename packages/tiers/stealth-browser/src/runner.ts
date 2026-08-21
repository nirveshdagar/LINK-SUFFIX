import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { synthesizeUA, templatesForProfile } from '@tah/ua';
import { timeZoneFromIP, resetTzCache, tzForGeo, commonTzForLocale, type Geo } from '@tah/tz';
import { request, ProxyAgent } from 'undici';
import type { Scenario, RequestEvent } from '@tah/contracts';
import type { DeviceProfile } from '@tah/profiles';

chromium.use(StealthPlugin());

async function probeEgressIP(proxyUrl: URL): Promise<string | null> {
  try {
    const res = await request('https://api.ipify.org?format=json', {
      dispatcher: new ProxyAgent({ uri: proxyUrl.toString() }),
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
  const browser = await chromium.launch({
    headless: true,
    args: [`--proxy-server=${proxyUrl.host}`],
  });

  let tzLookupFailed = false;
  let timezone = commonTzForLocale(device.locale);
  const egressIp = await probeEgressIP(proxyUrl);
  if (egressIp) {
    const tz = await timeZoneFromIP(egressIp);
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
      proxy: {
        server: `${proxyUrl.protocol}//${proxyUrl.host}`,
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password),
      },
    });
    page = await ctx.newPage();
    page.on('response', async (res) => {
      const t = Date.now();
      let body_snippet = '';
      try {
        const buf = await res.body();
        body_snippet = buf.toString('utf8', 0, 65536);
      } catch { /* ignore */ }
      events.push({
        url: res.url(), method: res.request().method(), status: res.status(),
        time_ms: Date.now() - t, headers: res.headers(), body_snippet, ta_signal: {
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
    scenario_id: scenario.id, repeat_index: 0, tier: 'stealth',
    geo_requested: scenario.geo, proxy_mode: scenario.proxy_mode,
    started_at: new Date(start).toISOString(), events,
    final_verdict: 'unsure',
    timing: { total_ms: Date.now() - start, pages_visited: 1 },
    error,
  };
}
