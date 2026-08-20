import { chromium, type Browser } from 'playwright';
import { synthesizeUA, templatesForProfile } from '@tah/ua';
import { timeZoneFromIP, resetTzCache, tzForGeo, commonTzForLocale, type Geo } from '@tah/tz';
import { request, ProxyAgent } from 'undici';
import { bezierMove, humanClick } from './behavior/mouse.js';
import { humanScroll } from './behavior/scroll.js';
import { TelemetryRecorder } from '@tah/telemetry';
import { logNormalTimeMs } from './behavior/timing.js';
import { extractInternalLinks, pickNextUrl } from './journey.js';
import path from 'node:path';
import type { Scenario, RequestEvent, RawRequestRecord } from '@tah/orchestrator';
import type { DeviceProfile } from '@tah/profiles';

const FALLBACK_LINKS = ['/', '/pricing', '/about', '/contact'] as const;

const buffer = Buffer.from(''); // geoip2-lite expects a Buffer; pass empty (mock for tests).

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
  const browser: Browser = await chromium.launch({
    headless: false, // human tier runs headed; smoke is gated separately
    // Chromium's --proxy-server accepts only host:port (no embedded creds).
    // Credentials come through newContext({ proxy: { username, password } }).
    args: [`--proxy-server=${proxyUrl.host}`],
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
  const session = scenario.session ?? { pages: { min: 6, max: 10 } };
  const min = session.pages?.min ?? 6;
  const max = session.pages?.max ?? 10;
  const target = min + Math.floor(Math.random() * (max - min + 1));
  const visitCounts = new Map<string, number>();
  const pages: string[] = [];
  const allEvents: RawRequestRecord[] = [];
  const start = Date.now();
  let mouseMoves = 0;
  let scrollPulses = 0;

  // humanClick is part of the public surface of behavior/mouse.ts; pulled
  // in here so downstream journey steps (e.g. clicking on a CTA) can use
  // it without re-importing the behavior module. Currently the journey
  // is link-driven so this stays as a no-op reference.
  void humanClick;

  let current = new URL(scenario.seed_url);
  for (let p = 0; p < target; p++) {
    // Pick fresh template + synthesize new fingerprint per navigation so
    // each leg of the journey presents a distinct UA, viewport, locale
    // and Accept-Language pair. Timezone is cached for the session.
    const template = templates[Math.floor(Math.random() * templates.length)]!;
    const fp = synthesizeUA(template, { timezone });
    const ctx = await browser.newContext({
      userAgent: fp.ua,
      viewport: { width: fp.fingerprint.viewport.w, height: fp.fingerprint.viewport.h },
      deviceScaleFactor: fp.fingerprint.viewport.dpr,
      locale: fp.fingerprint.locale,
      timezoneId: fp.fingerprint.timezone,
      extraHTTPHeaders: { 'Accept-Language': fp.fingerprint.languages.join(',') },
      hasTouch: device.touch,
      proxy: {
        server: `${proxyUrl.protocol}//${proxyUrl.host}`,
        username: decodeURIComponent(proxyUrl.username),
        password: decodeURIComponent(proxyUrl.password),
      },
    });
    const page = await ctx.newPage();
    const telemetry = new TelemetryRecorder(current.toString());
    const pAny = page as any;
    pAny.on('mousemove', (ev: any) => telemetry.recordMouseMove(ev.x, ev.y));
    pAny.on('click', (ev: any) => telemetry.recordClick(ev.x, ev.y, 'left', String(ev.button ?? 'left')));
    pAny.on('wheel', (ev: any) => telemetry.recordScroll(ev.deltaY ?? 0, ev.x, ev.y));
    pAny.on('keydown', () => telemetry.recordKeypress('key'));
    page.on('response', async (res) => {
      const t = Date.now();
      let snippet = '';
      try {
        const buf = await res.body();
        // Capture up to 64KB once so body-based challenge signatures can match.
        snippet = buf.subarray(0, 65536).toString('utf8');
      } catch {
        /* body may be unavailable for streaming responses; ignore */
      }
      allEvents.push({
        url: res.url(),
        method: res.request().method(),
        status: res.status(),
        time_ms: Date.now() - t,
        headers: res.headers(),
        ta_signal: {
          ua_actual: fp.ua,
          template_id: fp.templateId,
          timezone: fp.fingerprint.timezone,
          tz_lookup_failed: tzLookupFailed ? 'true' : 'false',
        },
        body_snippet: snippet,
      });
    });

    visitCounts.set(current.toString(), (visitCounts.get(current.toString()) ?? 0) + 1);
    pages.push(current.toString());
    // Cloudflare stalls the page in 'loading' state for synthetic fingerprints.
    // We use 'commit' (response headers landed) with a short timeout, then
    // continue regardless — TA verdict comes from response status + headers
    // + body snippet anyway.
    try {
      await page.goto(current.toString(), { waitUntil: 'commit', timeout: 8000 });
    } catch {
      // Connection stalled — proceed anyway; the response handler may
      // still have captured the initial headers before the stall.
    }
    await humanScroll(page);
    await page.waitForTimeout(logNormalTimeMs() / 4);
    mouseMoves++;
    scrollPulses++;
    telemetry.recordScroll(120, 0, 0);
    // Telemetry is written to $TAH_TELEMETRY_DIR if set (orchestrator
    // sets it before calling run()).
    const tdir = process.env.TAH_TELEMETRY_DIR;
    if (p === target - 1 && tdir) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(tdir, { recursive: true });
      telemetry.writeToFile(path.join(tdir, `repeat-${Date.now()}.jsonl`));
    }

    if (p < target - 1) {
      const base = new URL(current.toString());
      const links = await extractInternalLinks(page, base);
      let next: URL | null = pickNextUrl(links, visitCounts);
      if (!next) {
        const fbIdx = (p + 1) % FALLBACK_LINKS.length;
        next = new URL(base.origin + FALLBACK_LINKS[fbIdx]!);
      }
      await bezierMove(page, { x: Math.random() * 400 + 200, y: Math.random() * 200 + 200 });
      current = next;
    }
    await page.close();
    await ctx.close();
  }
  await browser.close();
  yield {
    scenario_id: scenario.id,
    repeat_index: 0,
    tier: 'human',
    geo_requested: scenario.geo,
    proxy_mode: scenario.proxy_mode,
    started_at: new Date(start).toISOString(),
    pages,
    events: allEvents,
    final_verdict: 'unsure',
    timing: {
      total_ms: Date.now() - start,
      pages_visited: pages.length,
      mouse_moves: mouseMoves,
      scroll_pulses: scrollPulses,
    },
  };
}