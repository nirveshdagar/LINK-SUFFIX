import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { loadProfile } from '@tah/profiles';
import { run } from './runner.js';

chromium.use(StealthPlugin());

describe('stealth-browser smoke', () => {
  it('does not expose navigator.webdriver = true to bot.sannysoft.com', async () => {
    if (!process.env.TAH_RUN_SMOKE) return;
    const browser = await chromium.launch({ headless: true });
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto('https://bot.sannysoft.com', {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      // Verify the runtime value directly: with stealth evasions applied,
      // `navigator.webdriver` must evaluate to false, not true.
      const webdriverFlag = await page.evaluate(
        () => (navigator as Navigator & { webdriver?: boolean }).webdriver === true,
      );
      expect(webdriverFlag).toBe(false);

      // Cross-check the rendered DOM: sannysoft renders the detection result
      // as text rows like "navigator.webdriver  true". With stealth active,
      // those rows should NOT contain the value `true`.
      const body = await page.content();
      expect(body.toLowerCase()).not.toMatch(/navigator\.webdriver.*?true/);
    } finally {
      await browser.close();
    }
  });
});

describe('stealth-browser fingerprint rotation', () => {
  it('produces ua_actual + template_id + timezone in ta_signal', async () => {
    if (!process.env.TAH_RUN_SMOKE) return;
    const profile = loadProfile('iphone-15-safari');
    const profile1 = loadProfile('iphone-15-safari');
    // Cast through unknown because tier's run() signature accepts a Scenario; we pass a stub.
    const stubScenario = {
      id: 'test', tier: 'stealth', seed_url: 'https://example.test/',
      geo: { country: 'US' }, proxy_mode: 'sticky-residential',
      repeats: 1, expected_verdict: 'allow',
    } as any;
    let fp1: any;
    for await (const e of run(stubScenario, new URL('http://127.0.0.1:1'), profile)) {
      fp1 = e.events[0]?.ta_signal;
    }
    let fp2: any;
    for await (const e of run(stubScenario, new URL('http://127.0.0.1:1'), profile1)) {
      fp2 = e.events[0]?.ta_signal;
    }
    expect(fp1?.ua_actual).toBeDefined();
    expect(fp1?.template_id).toBeDefined();
    expect(fp1?.timezone).toBeDefined();
    // Two runs should produce different UAs (random template + build)
    expect(fp1?.ua_actual).not.toBe(fp2?.ua_actual);
  });
});
