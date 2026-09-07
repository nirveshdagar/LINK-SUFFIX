import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

export interface NativeDesktopRuntime {
  env: Record<string, string>;
  isAlive(): boolean;
  onExit(listener: () => void): () => void;
  dispose(): Promise<void>;
}

const prefix = "tah-native-desktop-";
const startupMs = 8_000;
const shutdownMs = 2_000;

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess): Promise<boolean> {
  if (exited(child)) return true;
  return new Promise((resolve) => {
    const finish = (stopped: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(stopped);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(exited(child)), shutdownMs);
    child.once("exit", onExit);
  });
}

/** A private writable HOME and owned display, not a persistent user profile. */
export async function prepareNativeDesktopRuntime(options: {
  engine: string;
  headless: boolean;
  platform?: NodeJS.Platform;
}): Promise<NativeDesktopRuntime | undefined> {
  if ((options.platform ?? process.platform) !== "linux" ||
      options.engine !== "chromium" || options.headless) return undefined;

  const root = tmpdir();
  const home = await mkdtemp(join(root, prefix));
  const ownsHome = () => dirname(home) === root && home.startsWith(join(root, prefix));
  const listeners = new Set<() => void>();
  let display: ChildProcess | undefined;
  let alive = false;
  let disposal: Promise<void> | undefined;
  let spawned = false;
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: join(home, ".runtime"),
  });

  const onProcessExit = () => {
    try { if (display && !exited(display)) display.kill("SIGKILL"); } catch { /* Process already exited. */ }
    try { if (ownsHome()) rmSync(home, { recursive: true, force: true }); } catch { /* Best effort at process exit. */ }
  };
  const dispose = (): Promise<void> => disposal ??= (async () => {
    listeners.clear();
    alive = false;
    if (display && spawned && !exited(display)) {
      display.kill("SIGTERM");
      if (!await waitForExit(display)) {
        display.kill("SIGKILL");
        if (!await waitForExit(display)) throw new Error("Native desktop display did not stop");
      }
    }
    if (!ownsHome()) throw new Error("Native desktop cleanup path is outside its owned directory");
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
    process.off("exit", onProcessExit);
  })();

  process.once("exit", onProcessExit);
  try {
    for (const path of [env.XDG_CONFIG_HOME!, env.XDG_CACHE_HOME!, env.XDG_RUNTIME_DIR!]) {
      await mkdir(path, { mode: 0o700 });
    }
    display = spawn("Xvfb", [
      "-displayfd", "3", "-screen", "0", "1440x900x24", "-nolisten", "tcp",
    ], { env, stdio: ["ignore", "ignore", "pipe", "pipe"] });
    display.once("spawn", () => { spawned = true; });
    const markExited = () => {
      alive = false;
      for (const listener of listeners) listener();
    };
    display.on("exit", markExited);
    // Keep a permanent error listener: a child-process error must never escape.
    display.on("error", markExited);
    display.stderr?.resume();
    const pipe = display.stdio[3] as Readable | null;
    if (!pipe) throw new Error("Native desktop display did not provide a readiness pipe");
    const child = display;
    const number = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const finish = (error?: Error, value?: string) => {
        clearTimeout(timer);
        pipe.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error); else resolve(value!);
      };
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 128) return finish(new Error("Invalid native desktop display response"));
        if (!buffer.includes("\n")) return;
        const match = /^([0-9]{1,5})\r?\n$/.exec(buffer);
        if (!match) return finish(new Error("Invalid native desktop display number"));
        finish(undefined, match[1]!);
      };
      const onError = () => finish(new Error("Native desktop display could not start; Xvfb must be installed"));
      const onExit = () => finish(new Error("Native desktop display exited before readiness"));
      const timer = setTimeout(() => finish(new Error("Native desktop display startup timed out")), startupMs);
      pipe.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    if (exited(child)) throw new Error("Native desktop display exited during startup");
    alive = true;
    env.DISPLAY = ":" + number;
    return {
      env,
      isAlive: () => alive,
      onExit(listener) {
        listeners.add(listener);
        if (!alive) queueMicrotask(() => { if (listeners.has(listener)) listener(); });
        return () => { listeners.delete(listener); };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
