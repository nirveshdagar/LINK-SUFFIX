import { createHash } from "node:crypto";
import { chromium, webkit, type Browser } from "playwright";
import { prepareNativeDesktopRuntime } from "./nativeDesktopRuntime.js";

export type BrowserEngine = "chromium" | "webkit";
export interface BrowserLease { browser: Browser; release(): void; }
interface PoolEntry {
  browser?: Browser;
  launching?: Promise<Browser>;
  shutdown?: () => Promise<void>;
  activeContexts: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
}
type LeaseOptions = { engine: BrowserEngine; headless: boolean; proxyUrl?: URL };

const entries = new Map<string, PoolEntry>();
const activeProxyRoutes = new Set<string>();
const pendingCleanup = new Set<Promise<void>>();
let generation = 0;
let closing: Promise<void> | undefined;
const configuredIdleMs = Number(process.env.TAH_BROWSER_POOL_IDLE_MS ?? 120_000);
const idleMs = Number.isFinite(configuredIdleMs) ? Math.min(10 * 60_000, Math.max(60_000, configuredIdleMs)) : 120_000;

function trackCleanup(work: Promise<void>): void {
  pendingCleanup.add(work);
  void work.catch(() => {
    console.warn("[browser-pool] Browser runtime cleanup failed");
  }).finally(() => { pendingCleanup.delete(work); });
}

async function launchBrowser(options: LeaseOptions, entry: PoolEntry, acquiredGeneration: number): Promise<Browser> {
  const runtime = await prepareNativeDesktopRuntime(options);
  try {
    const browser = await (options.engine === "webkit" ? webkit : chromium).launch({
      headless: options.headless,
      timeout: 30_000,
      ...(runtime ? { env: runtime.env } : {}),
      ...(options.engine === "chromium" ? { args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] } : {}),
    });
    if (acquiredGeneration !== generation || (runtime && !runtime.isAlive())) {
      await browser.close().catch(() => undefined);
      throw new Error("Browser launch completed after pool shutdown or display exit");
    }
    const detach = runtime?.onExit(() => { void browser.close().catch(() => undefined); });
    let shutdown: Promise<void> | undefined;
    entry.shutdown = () => shutdown ??= (async () => {
      detach?.();
      try { await browser.close(); } finally { await runtime?.dispose(); }
    })();
    entry.browser = browser;
    browser.once("disconnected", () => {
      if (entry.browser === browser) entry.browser = undefined;
      detach?.();
      if (runtime) trackCleanup(runtime.dispose());
    });
    return browser;
  } catch (error) {
    await runtime?.dispose();
    throw error;
  }
}

export function proxyRouteIdentity(proxyUrl?: URL): string | undefined {
  if (!proxyUrl || proxyUrl.protocol === "direct:") return undefined;
  return createHash("sha256").update(proxyUrl.href).digest("hex");
}

export async function acquireBrowserLease(options: LeaseOptions): Promise<BrowserLease> {
  if (closing) throw new Error("Browser pool is closing");
  const acquiredGeneration = generation;
  const proxyRoute = proxyRouteIdentity(options.proxyUrl);
  if (proxyRoute && activeProxyRoutes.has(proxyRoute)) {
    throw new Error("Proxy route is already assigned to another active browser context");
  }
  if (proxyRoute) activeProxyRoutes.add(proxyRoute);
  const key = options.engine + ":" + (options.headless ? "headless" : "visible");
  let entry = entries.get(key);
  if (!entry) {
    entry = { activeContexts: 0, lastUsedAt: Date.now() };
    entries.set(key, entry);
  }
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  try {
    if (!entry.browser?.isConnected()) {
      const launching = entry.launching ??= launchBrowser(options, entry, acquiredGeneration);
      try { await launching; } finally { if (entry.launching === launching) entry.launching = undefined; }
    }
    if (acquiredGeneration !== generation || !entry.browser?.isConnected()) {
      throw new Error("Browser pool closed before the context lease was ready");
    }
    entry.activeContexts += 1;
    entry.lastUsedAt = Date.now();
    let released = false;
    return {
      browser: entry.browser,
      release() {
        if (released) return;
        released = true;
        if (acquiredGeneration !== generation) return;
        if (proxyRoute) activeProxyRoutes.delete(proxyRoute);
        entry!.activeContexts = Math.max(0, entry!.activeContexts - 1);
        entry!.lastUsedAt = Date.now();
        if (entry!.activeContexts === 0) {
          entry!.idleTimer = setTimeout(() => {
            const shutdown = entry!.shutdown;
            entry!.browser = undefined;
            entry!.shutdown = undefined;
            entry!.idleTimer = undefined;
            if (shutdown) trackCleanup(shutdown());
          }, idleMs);
          entry!.idleTimer.unref();
        }
      },
    };
  } catch (error) {
    if (proxyRoute && acquiredGeneration === generation) activeProxyRoutes.delete(proxyRoute);
    throw error;
  }
}

export function browserPoolStats() {
  const values = [...entries.values()];
  return {
    browserInstances: values.filter((entry) => entry.browser?.isConnected()).length,
    activeContexts: values.reduce((sum, entry) => sum + entry.activeContexts, 0),
    activeProxyRoutes: activeProxyRoutes.size,
    launchingInstances: values.filter((entry) => entry.launching).length,
    idleTimeoutMs: idleMs,
  };
}

export async function closeBrowserPool(): Promise<void> {
  if (closing) return closing;
  generation += 1;
  const pending = [...entries.values()];
  entries.clear();
  activeProxyRoutes.clear();
  closing = (async () => {
    await Promise.allSettled(pending.map(async (entry) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      await entry.launching?.catch(() => undefined);
      await entry.shutdown?.();
    }));
    await Promise.allSettled([...pendingCleanup]);
  })();
  try { await closing; } finally { closing = undefined; }
}
