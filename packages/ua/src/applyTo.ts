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

export async function installFingerprintProfile(
  context: BrowserContext,
  fp: SynthesizedFingerprint,
  mode: 'balanced' | 'hardened' = 'hardened',
): Promise<void> {
  const mobile = /iPhone|iPad|Android|Mobile/i.test(fp.ua);
  const platform = /iPhone|iPad/i.test(fp.ua) ? 'iPhone' : /Android/i.test(fp.ua) ? 'Linux armv8l' : /Macintosh/i.test(fp.ua) ? 'MacIntel' : 'Win32';
  const seed = Array.from(fp.templateId + fp.build).reduce((n, ch) => ((n * 31) + ch.charCodeAt(0)) >>> 0, 2166136261);
  const config = {
    mode, seed, platform, mobile,
    width: fp.fingerprint.viewport.w,
    height: fp.fingerprint.viewport.h,
    dpr: fp.fingerprint.viewport.dpr,
    cores: fp.fingerprint.hardware.cores,
    memory: fp.fingerprint.hardware.memoryGb,
    webglVendor: fp.fingerprint.webgl.vendor,
    webglRenderer: fp.fingerprint.webgl.renderer,
  };
  await context.addInitScript(`(() => {
    const c = ${JSON.stringify(config)};
    const getter = (target, key, value) => { try { Object.defineProperty(target, key, { get: () => value, configurable: true }); } catch {} };
    getter(Navigator.prototype, 'hardwareConcurrency', c.cores);
    getter(Navigator.prototype, 'deviceMemory', c.memory);
    getter(Navigator.prototype, 'platform', c.platform);
    getter(Navigator.prototype, 'maxTouchPoints', c.mobile ? 5 : 0);
    getter(Navigator.prototype, 'webdriver', false);
    for (const [key, value] of Object.entries({ width:c.width, height:c.height, availWidth:c.width, availHeight:c.height, colorDepth:24, pixelDepth:24 })) getter(Screen.prototype, key, value);
    const gl = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) { if (p === 37445) return c.webglVendor; if (p === 37446) return c.webglRenderer; return gl.call(this,p); };
    if (globalThis.WebGL2RenderingContext) {
      const gl2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(p) { if (p === 37445) return c.webglVendor; if (p === 37446) return c.webglRenderer; return gl2.call(this,p); };
    }
    if (c.mode === 'hardened') {
      const image = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function(...args) { const out=image.apply(this,args); if(out.data.length>3){ const i=(c.seed%(out.data.length/4))*4; out.data[i]=(out.data[i]+(c.seed%3))&255; } return out; };
      if (globalThis.AudioBuffer) {
        const channel = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function(...args) { const out=channel.apply(this,args); if(out.length){ const i=c.seed%out.length; out[i]+=((c.seed%7)-3)*1e-8; } return out; };
      }
    }
  })();`);
}
