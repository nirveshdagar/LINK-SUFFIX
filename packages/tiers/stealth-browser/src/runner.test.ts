import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

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
