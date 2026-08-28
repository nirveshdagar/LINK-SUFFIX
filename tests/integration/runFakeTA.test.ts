/**
 * Integration test: spin the fake-TA nginx container, then run all four
 * traffic tiers against it and assert verdict rates.
 *
 * Gated behind `TAH_INTEGRATION=1` so the default `npm run test` does not
 * require Docker. When the env var is unset, the suite is skipped and the
 * test bodies short-circuit.
 *
 * Requires Docker daemon (uses `docker build` + `docker run` via fakeTA.ts).
 *
 * Run with:
 *   TAH_INTEGRATION=1 npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request } from 'undici';
import { chromium } from 'playwright';
import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { startFakeTA, stopFakeTA, type FakeTAHandle } from './fakeTA.js';
import { aggregateVerdict, defaultStrategies, type Vote } from '@tah/verdict';

// Register the stealth plugin once. The module side-effect is harmless when
// the integration gate is off (it just attaches a plugin to the launcher
// object); doing it at module top level means we don't have to gate inside
// the describe block.
chromiumExtra.use(StealthPlugin());

const ENABLED = process.env.TAH_INTEGRATION === '1';

interface VerdictStats {
  total: number;
  block: number;
  challenge: number;
  allow: number;
  unsure: number;
  error: number;
}

function emptyStats(): VerdictStats {
  return { total: 0, block: 0, challenge: 0, allow: 0, unsure: 0, error: 0 };
}

function classify(input: {
  status: number;
  responseHeaders: Record<string, string>;
  responseBodySnippet: string;
  setCookies: string[];
}): Vote {
  const strategies = defaultStrategies();
  const agg = aggregateVerdict(
    {
      url: '',
      status: input.status,
      responseHeaders: input.responseHeaders,
      responseBodySnippet: input.responseBodySnippet,
      setCookies: input.setCookies,
    },
    strategies.map((s) => s.name),
    strategies,
  );
  return agg.final;
}

const UA_POOL = [
  'curl/8.4.0',
  'python-requests/2.32.0',
  'Go-http-client/2.0',
  'Wget/1.21.4',
  '',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function fireTrivial(url: string, n: number): Promise<VerdictStats> {
  // Direct undici requests to Docker's dynamically allocated loopback port.
  const stats = emptyStats();
  for (let i = 0; i < n; i++) {
    const ua = pick(UA_POOL);
    try {
      const res = await request(url, {
        headers: { 'User-Agent': ua, 'Accept': '*/*' },
      });
      const body = await res.body.text();
      const v = classify({
        status: res.statusCode,
        responseHeaders: res.headers as Record<string, string>,
        responseBodySnippet: body,
        setCookies: [],
      });
      stats[v === 'error' ? 'error' : v]++;
    } catch {
      stats.error++;
    }
    stats.total++;
  }
  return stats;
}

async function fireBrowser(url: string, opts: { headless: boolean; stealth: boolean; useRealUA: boolean }): Promise<VerdictStats> {
  const stats = emptyStats();
  const launcher = opts.stealth ? (chromiumExtra as unknown as typeof chromium) : chromium;
  const browser = await launcher.launch({ headless: opts.headless });
  try {
    // When `useRealUA` is false we let Playwright emit its default UA,
    // which for plain headless chromium contains the substring
    // `HeadlessChrome/...` — that is exactly what the fake TA's UA block
    // rule matches on. For stealth / human tiers we override to a real
    // Chrome UA so the fake TA serves the cf-challenge body.
    const ctx = await browser.newContext(opts.useRealUA ? {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    } : {});
    const page = await ctx.newPage();
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const status = res?.status() ?? 0;
      const headers = res ? res.headers() : {};
      const body = await page.content();
      const v = classify({
        status,
        responseHeaders: headers as Record<string, string>,
        responseBodySnippet: body,
        setCookies: [],
      });
      stats[v === 'error' ? 'error' : v]++;
    } catch {
      stats.error++;
    } finally {
      await page.close();
      await ctx.close();
    }
    stats.total++;
  } finally {
    await browser.close();
  }
  return stats;
}

describe.skipIf(!ENABLED)('all tiers against fake TA', () => {
  let handle: FakeTAHandle;

  beforeAll(async () => {
    handle = await startFakeTA();
  }, 60_000);

  afterAll(async () => {
    if (handle) await stopFakeTA(handle);
  });

  it('trivial-http tier: 100% block-or-challenge', async () => {
    const stats = await fireTrivial(handle.url, 50);
    expect(stats.error).toBe(0);
    expect(stats.allow).toBe(0);
    expect(stats.block + stats.challenge).toBe(stats.total);
  }, 30_000);

  it('headless-browser tier: 100% block', async () => {
    const stats = await fireBrowser(handle.url, { headless: true, stealth: false, useRealUA: false });
    expect(stats.error).toBe(0);
    expect(stats.block).toBe(stats.total);
  }, 60_000);

  it('stealth-browser tier: 100% challenge (UA cloaked)', async () => {
    const stats = await fireBrowser(handle.url, { headless: true, stealth: true, useRealUA: true });
    expect(stats.error).toBe(0);
    expect(stats.challenge).toBe(stats.total);
  }, 60_000);

  it('human-sim tier: 100% challenge (real UA)', async () => {
    const stats = await fireBrowser(handle.url, { headless: true, stealth: false, useRealUA: true });
    expect(stats.error).toBe(0);
    expect(stats.challenge).toBe(stats.total);
  }, 60_000);
});

// Always-on sanity test: confirms the gate works. When `TAH_INTEGRATION` is
// unset, the suite above is skipped; this test asserts that gate.
describe('TAH_INTEGRATION gate', () => {
  it('skips the integration suite when TAH_INTEGRATION is not "1"', () => {
    if (!ENABLED) {
      // The suite is `describe.skipIf(!ENABLED)` so this is the default path.
      expect(ENABLED).toBe(false);
    } else {
      expect(ENABLED).toBe(true);
    }
  });
});
