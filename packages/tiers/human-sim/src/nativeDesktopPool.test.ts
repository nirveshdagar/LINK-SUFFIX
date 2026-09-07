import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chromium, webkit, type Browser } from "playwright";
import { prepareNativeDesktopRuntime, type NativeDesktopRuntime } from "./nativeDesktopRuntime.js";
import { acquireBrowserLease, closeBrowserPool, browserPoolStats } from "./browserPool.js";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() }, webkit: { launch: vi.fn() } }));
vi.mock("./nativeDesktopRuntime.js", () => ({ prepareNativeDesktopRuntime: vi.fn() }));
class MockBrowser extends EventEmitter {
  connected = true;
  isConnected() { return this.connected; }
  close = vi.fn(async () => { this.connected = false; this.emit("disconnected"); });
}
let browser: MockBrowser;
const prepare = vi.mocked(prepareNativeDesktopRuntime);
const launch = vi.mocked(chromium.launch);
const webkitLaunch = vi.mocked(webkit.launch);
function desktop() {
  let alive = true;
  const listeners = new Set<() => void>();
  const runtime: NativeDesktopRuntime = {
    env: { HOME: "/private/fixture", DISPLAY: ":91" },
    isAlive: () => alive,
    onExit: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: vi.fn(async () => undefined),
  };
  prepare.mockImplementation(async options => options.headless ? undefined : runtime);
  return { runtime, stop: () => { alive = false; for (const fn of listeners) fn(); } };
}
beforeEach(() => {
  vi.clearAllMocks();
  prepare.mockResolvedValue(undefined);
  browser = new MockBrowser();
  launch.mockResolvedValue(browser as unknown as Browser);
  webkitLaunch.mockResolvedValue(browser as unknown as Browser);
});
afterEach(async () => { await closeBrowserPool(); vi.useRealTimers(); });

describe("pooled native desktop lifecycle", () => {
  it("leaves existing headless launch environment unchanged", async () => {
    const lease = await acquireBrowserLease({ engine: "chromium", headless: true });
    expect(launch).toHaveBeenCalledWith({
      headless: true, timeout: 30000,
      args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    lease.release();
  });
  it("shares one opted-in desktop browser, not context state or proxy routes", async () => {
    const { runtime } = desktop();
    const [a, b] = await Promise.all([
      acquireBrowserLease({ engine: "chromium", headless: false, proxyUrl: new URL("http://one:pass@proxy.invalid:1000") }),
      acquireBrowserLease({ engine: "chromium", headless: false, proxyUrl: new URL("http://two:pass@proxy.invalid:1000") }),
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]?.env).toBe(runtime.env);
    expect(browserPoolStats().activeContexts).toBe(2);
    a.release(); b.release();
    await closeBrowserPool();
    expect(browserPoolStats().activeProxyRoutes).toBe(0);
    expect(runtime.dispose).toHaveBeenCalled();
  });
  it("retains exclusive active proxy-route protection", async () => {
    const options = { engine: "chromium" as const, headless: true, proxyUrl: new URL("http://same:pass@proxy.invalid:1000") };
    const a = await acquireBrowserLease(options);
    await expect(acquireBrowserLease(options)).rejects.toThrow("already assigned");
    a.release();
  });
  it("cleans up a failed browser launch and allows the route to be reused", async () => {
    const { runtime } = desktop();
    launch.mockRejectedValueOnce(new Error("launch failure"));
    const options = { engine: "chromium" as const, headless: false, proxyUrl: new URL("http://one:pass@proxy.invalid:1000") };
    await expect(acquireBrowserLease(options)).rejects.toThrow("launch failure");
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    const lease = await acquireBrowserLease(options);
    lease.release();
  });
  it("closes Chromium if its owned display exits unexpectedly", async () => {
    const { stop, runtime } = desktop();
    const lease = await acquireBrowserLease({ engine: "chromium", headless: false });
    stop();
    expect(browser.close).toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
    lease.release();
  });
  it("cleans up a native runtime when shutdown races an in-flight launch", async () => {
    const { runtime } = desktop();
    let complete!: (browser: Browser) => void;
    launch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const acquire = acquireBrowserLease({ engine: "chromium", headless: false });
    const rejected = expect(acquire).rejects.toThrow("after pool shutdown");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const closed = closeBrowserPool();
    complete(browser as unknown as Browser);
    await rejected; await closed;
    expect(browser.close).toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
    expect(browserPoolStats().browserInstances).toBe(0);
  });
  it("releases idle desktop resources", async () => {
    vi.useFakeTimers();
    const { runtime } = desktop();
    const lease = await acquireBrowserLease({ engine: "chromium", headless: false });
    lease.release();
    await vi.advanceTimersByTimeAsync(browserPoolStats().idleTimeoutMs + 1);
    expect(browser.close).toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
  });
});
