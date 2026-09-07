import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, stat } from "node:fs/promises";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { prepareNativeDesktopRuntime, type NativeDesktopRuntime } from "./nativeDesktopRuntime.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class Display extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stderr = new PassThrough();
  stdio = [null, null, this.stderr, new PassThrough()];
  kill = vi.fn((signal: string) => {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  });
  ready() { this.emit("spawn"); (this.stdio[3] as PassThrough).write("91\n"); }
}
const spawnMock = vi.mocked(spawn);
let display: Display;
const runtimes: NativeDesktopRuntime[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  display = new Display();
  spawnMock.mockImplementation(() => {
    setImmediate(() => display.ready());
    return display as unknown as ReturnType<typeof spawn>;
  });
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.useRealTimers();
});
async function start() {
  const runtime = await prepareNativeDesktopRuntime({ engine: "chromium", headless: false, platform: "linux" });
  expect(runtime).toBeDefined();
  runtimes.push(runtime!);
  return runtime!;
}

describe("native desktop runtime", () => {
  it.each([
    { engine: "chromium", headless: true, platform: "linux" as const },
    { engine: "webkit", headless: false, platform: "linux" as const },
    { engine: "chromium", headless: false, platform: "win32" as const },
  ])("leaves unsupported or headless modes untouched: %j", async (options) => {
    expect(await prepareNativeDesktopRuntime(options)).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("uses a private writable home without mutating global environment", async () => {
    const original = { HOME: process.env.HOME, DISPLAY: process.env.DISPLAY };
    const runtime = await start();
    expect(runtime.env.DISPLAY).toBe(":91");
    expect(runtime.env.HOME).not.toBe(original.HOME);
    await access(runtime.env.XDG_CONFIG_HOME!);
    await access(runtime.env.XDG_CACHE_HOME!);
    await access(runtime.env.XDG_RUNTIME_DIR!);
    if (process.platform !== "win32") expect((await stat(runtime.env.HOME!)).mode & 0o777).toBe(0o700);
    expect({ HOME: process.env.HOME, DISPLAY: process.env.DISPLAY }).toEqual(original);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("Xvfb");
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["-displayfd", "3", "-screen", "0", "1440x900x24", "-nolisten", "tcp"]);
  });
  it("removes owned storage and stops only its display, idempotently", async () => {
    const runtime = await start();
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    expect(display.kill).toHaveBeenCalledTimes(1);
    expect(display.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(access(runtime.env.HOME!)).rejects.toThrow();
  });
  it("allocates different homes for independent pooled browsers", async () => {
    const first = await start();
    display = new Display();
    const second = await start();
    expect(first.env.HOME).not.toBe(second.env.HOME);
  });
  it("reports unexpected display exit", async () => {
    const runtime = await start();
    const onExit = vi.fn();
    runtime.onExit(onExit);
    display.exitCode = 1; display.emit("exit", 1);
    expect(runtime.isAlive()).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
  it("cleans up when Xvfb is missing", async () => {
    spawnMock.mockImplementation(() => {
      setImmediate(() => display.emit("error", new Error("ENOENT")));
      return display as unknown as ReturnType<typeof spawn>;
    });
    await expect(start()).rejects.toThrow("Xvfb must be installed");
    const home = (spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> }).env.HOME!;
    await expect(access(home)).rejects.toThrow();
    expect(display.kill).not.toHaveBeenCalled();
  });
  it("rejects malformed display readiness instead of launching Chromium", async () => {
    spawnMock.mockImplementation(() => {
      setImmediate(() => { display.emit("spawn"); (display.stdio[3] as PassThrough).write("not-a-display\n"); });
      return display as unknown as ReturnType<typeof spawn>;
    });
    await expect(start()).rejects.toThrow("Invalid native desktop display number");
    expect(display.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
