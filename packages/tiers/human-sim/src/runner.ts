import { chromium, type Response, type Browser, type Page } from 'playwright';
import { bezierMove, humanClick } from './behavior/mouse.js';
import { humanScroll } from './behavior/scroll.js';
import { logNormalTimeMs } from './behavior/timing.js';
import { extractInternalLinks, pickNextUrl } from './journey.js';
import type { Scenario, RequestEvent, RawRequestRecord } from '@tah/orchestrator';
import type { DeviceProfile } from '@tah/profiles';

const FALLBACK_LINKS = ['/', '/pricing', '/about', '/contact'] as const;

interface VisitResult {
  events: RawRequestRecord[];
  linkFallback: boolean;
}

/**
 * Visit a URL on the given page. Captures every `response` event into
 * `events`; runs `humanScroll` to look realistic; sleeps a fraction of
 * the log-normal inter-page wait so the timing distribution still
 * looks human if we bail out early.
 *
 * The response handler is attached for the lifetime of this single
 * visit and removed in a `finally` block so it does not leak into the
 * next visit's event stream.
 */
async function visitPage(page: Page, url: URL): Promise<VisitResult> {
  const events: RawRequestRecord[] = [];
  const handler = async (res: Response): Promise<void> => {
    const start = Date.now();
    try {
      await res.body();
    } catch {
      /* body may be unavailable for streaming responses; ignore */
    }
    events.push({
      url: res.url(),
      method: res.request().method(),
      status: res.status(),
      time_ms: Date.now() - start,
      headers: res.headers(),
      ta_signal: {},
    });
  };
  page.on('response', handler);
  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await humanScroll(page);
    await page.waitForTimeout(logNormalTimeMs() / 4);
  } finally {
    page.off('response', handler);
  }
  const base = new URL(url.toString());
  const links = await extractInternalLinks(page, base);
  const linkFallback = links.length < 3;
  return { events, linkFallback };
}

export async function* run(
  scenario: Scenario,
  proxyUrl: URL,
  device: DeviceProfile,
): AsyncIterable<RequestEvent> {
  const browser: Browser = await chromium.launch({
    headless: false, // human tier runs headed; smoke is gated separately
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

  // humanClick is part of the public surface of behavior/mouse.ts; pulled
  // in here so downstream journey steps (e.g. clicking on a CTA) can use
  // it without re-importing the behavior module. Currently the journey
  // is link-driven so this stays as a no-op reference.
  void humanClick;

  try {
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

    let current = new URL(scenario.seed_url);
    for (let p = 0; p < target; p++) {
      visitCounts.set(current.toString(), (visitCounts.get(current.toString()) ?? 0) + 1);
      pages.push(current.toString());
      const { events } = await visitPage(page, current);
      allEvents.push(...events);
      if (p < target - 1) {
        const base = new URL(current.toString());
        const links = await extractInternalLinks(page, base);
        let next: URL | null = pickNextUrl(links, visitCounts);
        if (!next) {
          const fbIdx = (p + 1) % FALLBACK_LINKS.length;
          next = new URL(base.origin + FALLBACK_LINKS[fbIdx]!);
        }
        // small in-page motion between pages (counts feed into timing later)
        await bezierMove(page, { x: Math.random() * 400 + 200, y: Math.random() * 200 + 200 });
        mouseMoves++;
        scrollPulses++;
        current = next;
      }
    }
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
      timing: { total_ms: Date.now() - start, pages_visited: pages.length, mouse_moves: mouseMoves, scroll_pulses: scrollPulses },
    };
  } finally {
    await page.close();
    await ctx.close();
    await browser.close();
  }
}
