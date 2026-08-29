import { chromium, webkit, type Browser } from "playwright";

export type BrowserEngine = "chromium" | "webkit";

export interface BrowserLease {
  browser: Browser;
  release(): void;
}

interface PoolEntry {
  browser?: Browser;
  launching?: Promise<Browser>;
  activeContexts: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
}

const entries = new Map<string, PoolEntry>();
const configuredIdleMs = Number(process.env.TAH_BROWSER_POOL_IDLE_MS ?? 120_000);
const idleMs = Number.isFinite(configuredIdleMs) ? Math.min(10 * 60_000, Math.max(60_000, configuredIdleMs)) : 120_000;

export async function acquireBrowserLease(options: { engine: BrowserEngine; headless: boolean }): Promise<BrowserLease> {
  const key = `${options.engine}:${options.headless ? "headless" : "visible"}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { activeContexts: 0, lastUsedAt: Date.now() };
    entries.set(key, entry);
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  if (!entry.browser?.isConnected()) {
    entry.launching ??= (options.engine === "webkit" ? webkit : chromium).launch({
      headless: options.headless,
      ...(options.engine === "chromium" ? { args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] } : {}),
    }).then((browser) => {
      entry!.browser = browser;
      entry!.launching = undefined;
      browser.once("disconnected", () => { if (entry?.browser === browser) entry.browser = undefined; });
      return browser;
    }, (error) => {
      entry!.launching = undefined;
      throw error;
    });
    entry.browser = await entry.launching;
  }
  entry.activeContexts += 1;
  entry.lastUsedAt = Date.now();
  let released = false;
  return {
    browser: entry.browser,
    release() {
      if (released) return;
      released = true;
      entry!.activeContexts = Math.max(0, entry!.activeContexts - 1);
      entry!.lastUsedAt = Date.now();
      if (entry!.activeContexts === 0) {
        entry!.idleTimer = setTimeout(() => {
          const browser = entry!.browser;
          entry!.browser = undefined;
          entry!.idleTimer = undefined;
          if (browser?.isConnected()) void browser.close().catch(() => undefined);
        }, idleMs);
        entry!.idleTimer.unref();
      }
    },
  };
}

export function browserPoolStats() {
  const values = [...entries.values()];
  return {
    browserInstances: values.filter((entry) => entry.browser?.isConnected()).length,
    activeContexts: values.reduce((sum, entry) => sum + entry.activeContexts, 0),
    launchingInstances: values.filter((entry) => entry.launching).length,
    idleTimeoutMs: idleMs,
  };
}

export async function closeBrowserPool(): Promise<void> {
  const browsers: Browser[] = [];
  for (const entry of entries.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.browser?.isConnected()) browsers.push(entry.browser);
  }
  entries.clear();
  await Promise.allSettled(browsers.map((browser) => browser.close()));
}
