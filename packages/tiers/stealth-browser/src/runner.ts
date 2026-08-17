import { chromium } from 'playwright-extra';
import type { Browser, Response } from 'playwright-core';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Scenario, RequestEvent } from '@tah/orchestrator';
import type { DeviceProfile } from '@tah/profiles';

chromium.use(StealthPlugin());

export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  device: DeviceProfile,
): AsyncIterable<RequestEvent> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: [`--proxy-server=${proxyUrl.toString()}`],
  });
  const ctx = await browser.newContext({
    userAgent: device.uaFamily,
    viewport: { width: device.viewport.w, height: device.viewport.h },
    deviceScaleFactor: device.viewport.dpr,
    locale: device.locale,
    hasTouch: device.touch,
  });
  const page = await ctx.newPage();
  const events: RequestEvent['events'] = [];
  page.on('response', async (res: Response) => {
    const start = Date.now();
    let snippet = '';
    try {
      const buf = await res.body();
      // Capture up to 64KB once so we can attach it to the request record
      // without re-consuming the stream.
      snippet = buf.subarray(0, 65536).toString('utf8');
    } catch { /* body may be unavailable for streaming responses */ }
    events.push({
      url: res.url(),
      method: res.request().method(),
      status: res.status(),
      time_ms: Date.now() - start,
      headers: res.headers(),
      ta_signal: {},
      body_snippet: snippet,
    });
  });
  const start = Date.now();
  let resp: Awaited<ReturnType<typeof page.goto>>;
  try {
    resp = await page.goto(scenario.seed_url, { waitUntil: 'domcontentloaded' });
  } finally {
    await page.close();
    await ctx.close();
    await browser.close();
  }
  yield {
    scenario_id: scenario.id,
    repeat_index: 0,
    tier: 'stealth',
    geo_requested: scenario.geo,
    proxy_mode: scenario.proxy_mode,
    started_at: new Date().toISOString(),
    events,
    final_verdict: 'unsure',
    timing: { total_ms: Date.now() - start, pages_visited: 1 },
    error: resp ? undefined : 'navigation failed',
  };
}
