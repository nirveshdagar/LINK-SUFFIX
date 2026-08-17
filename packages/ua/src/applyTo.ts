import type { Page, BrowserContext, Browser } from 'playwright';
import type { SynthesizedFingerprint } from './types.js';

/**
 * Reconfigure an existing Playwright page with a synthesized fingerprint.
 * This is used when we keep the same browser context and just rotate UA headers +
 * tzId between navigations. NOTE: this approach cannot rotate JS-readable
 * `navigator.userAgent` — use `createContextWithFingerprint` instead when full
 * consistency is required.
 */
export async function applyHeadersToPage(page: Page, fp: SynthesizedFingerprint): Promise<void> {
  await page.setExtraHTTPHeaders({ 'User-Agent': fp.ua });
  // Sec-CH-UA headers cannot be set from JS; Playwright will set them on next request if launched with the right UA at newContext time.
}

/**
 * Create a brand-new BrowserContext configured with the fingerprint. This is
 * the recommended path: it makes HTTP UA header, JS-readable navigator.userAgent,
 * Intl.DateTimeFormat().resolvedOptions().timeZone, and navigator.languages all
 * consistent with the fingerprint bundle.
 */
export async function createContextWithFingerprint(
  browser: Browser,
  fp: SynthesizedFingerprint,
  proxyUrl: URL,
): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: fp.ua,
    viewport: { width: fp.fingerprint.viewport.w, height: fp.fingerprint.viewport.h },
    deviceScaleFactor: fp.fingerprint.viewport.dpr,
    locale: fp.fingerprint.locale,
    timezoneId: fp.fingerprint.timezone,
    extraHTTPHeaders: { 'Accept-Language': fp.fingerprint.languages.join(',') },
    proxy: { server: proxyUrl.toString() },
  });
}
