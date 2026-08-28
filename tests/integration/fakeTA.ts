/**
 * Helper that builds and starts the fake-TA nginx container.
 *
 * Uses the Docker CLI directly via `child_process.execFile` so we do not
 * depend on `dockerode`. Returns the URL the container is bound to
 * (e.g. http://127.0.0.1:8080/) once the container responds to requests.
 *
 * Exports `startFakeTA()` and `stopFakeTA()` so vitest can hook them into
 * `beforeAll` / `afterAll`. Both are no-ops when `TAH_INTEGRATION` is unset
 * (see runFakeTA.test.ts for the env-gated skip behaviour).
 *
 * Implementation notes:
 * - On Windows the vitest worker runs with a stripped PATH that does not
 *   include the Docker Desktop install directory. We probe well-known
 *   absolute paths and fall back to PATH lookup via `where` so the test
 *   works regardless of how Docker was installed. Set `DOCKER_BIN` to
 *   override (e.g. `/usr/bin/docker` on Linux).
 * - `execFile` is called with forward-slash absolute paths on Windows
 *   (Node handles them natively, avoids the spaces-in-path quoting pitfall
 *   that breaks `shell: true`).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { request } from 'undici';

const execFileP = promisify(execFile);

const IMAGE_TAG = 'tah-fake-ta:dev';
const CONTAINER_NAME = `tah-fake-ta-${process.pid}-${Date.now()}`;

export interface FakeTAHandle {
  url: string;
  containerName: string;
  imageTag: string;
}

let cachedDocker: string | null = null;

/**
 * Locate a working docker executable. Probes an explicit override first,
 * then well-known Windows install paths, then falls back to PATH lookup
 * via `where` (Windows) / `which` (POSIX).
 */
async function resolveDocker(): Promise<string> {
  if (cachedDocker) return cachedDocker;
  if (process.env.DOCKER_BIN) {
    cachedDocker = process.env.DOCKER_BIN;
    return cachedDocker;
  }

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push(
      'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
      'C:/Program Files/Docker/Docker/bin/docker.exe',
    );
  } else {
    candidates.push('/usr/bin/docker', '/usr/local/bin/docker');
  }

  for (const c of candidates) {
    try {
      await execFileP(c, ['--version']);
      cachedDocker = c;
      return c;
    } catch {
      /* try next */
    }
  }

  // PATH lookup via shell. We trust the env here because the worker
  // doesn't expose PATH that Node can use for direct execFile.
  const where = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(where, ['docker']);
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) {
      cachedDocker = first.trim();
      return cachedDocker;
    }
  } catch {
    /* fall through */
  }

  throw new Error('docker executable not found; set DOCKER_BIN to override');
}

/**
 * Build the fake-TA image (idempotent) and let Docker allocate a free
 * loopback host port.
 * Polls `GET /` for up to ~10s and returns the URL once nginx is up.
 */
export async function startFakeTA(imageContextDir?: string): Promise<FakeTAHandle> {
  const ctxDir = imageContextDir ?? fileURLToPath(new URL('.', import.meta.url));
  const docker = await resolveDocker();

  // docker build (context = dir holding the Dockerfile + fake-ta.conf).
  // We name the Dockerfile `fake-ta.Dockerfile` (not the default `Dockerfile`)
  // so it is unmistakable inside `tests/integration/`. -q keeps output to just
  // the image id so we can scrape it cleanly.
  await execFileP(docker, ['build', '-q', '-f', 'fake-ta.Dockerfile', '-t', IMAGE_TAG, '.'], {
    cwd: ctxDir,
  });

  // Best-effort cleanup of any stale container with the same name.
  await execFileP(docker, ['rm', '-f', CONTAINER_NAME]).catch(() => undefined);

  // Run detached, publish container port 8080 on an available loopback port,
  // and discover the assigned mapping. This avoids collisions with local
  // development services.
  await execFileP(docker, [
    'run', '-d',
    '--name', CONTAINER_NAME,
    '-p', '127.0.0.1::8080',
    '--rm',
    IMAGE_TAG,
  ]);
  const { stdout: mapping } = await execFileP(docker, ['port', CONTAINER_NAME, '8080/tcp']);
  const port = mapping.match(/:(\d+)\s*$/m)?.[1];
  if (!port) {
    await execFileP(docker, ['rm', '-f', CONTAINER_NAME]).catch(() => undefined);
    throw new Error(`Docker did not publish fake TA port 8080: ${mapping.trim()}`);
  }
  const publicUrl = `http://127.0.0.1:${port}`;

  // Poll until nginx answers (max 10s).
  const deadline = Date.now() + 10_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await request(publicUrl, { method: 'GET' });
      await res.body.dump();
      if (res.statusCode === 200 || res.statusCode === 403) {
        return { url: publicUrl, containerName: CONTAINER_NAME, imageTag: IMAGE_TAG };
      }
    } catch (e) {
      lastErr = e;
    }
    await delay(250);
  }
  throw new Error(`fake TA never came up at ${publicUrl}: ${String(lastErr)}`);
}

/** Stop and remove the container. Safe to call multiple times. */
export async function stopFakeTA(handle: FakeTAHandle): Promise<void> {
  const docker = await resolveDocker();
  await execFileP(docker, ['rm', '-f', handle.containerName]).catch(() => undefined);
}
