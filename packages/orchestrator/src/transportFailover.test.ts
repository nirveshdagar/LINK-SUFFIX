import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateCaptureResult, type EventBus, type RequestEvent, type Scenario } from '@tah/contracts';
import { ProxyTransportError, isProxyTransportFailure } from '@tah/proxy';
import { runScenario, type ContextProxyAllocator, type ContextProxyOutcome } from './runner.js';
import { classifyAttemptOutcome } from './attemptOutcome.js';
import { CaptureBackoff } from './captureBackoff.js';
import { releaseCampaignProxy, type CampaignProxyLease } from './proxyRuntimeClient.js';

const mock = vi.hoisted(() => ({
  load: vi.fn(), human: vi.fn(), redirect: vi.fn(),
  lifecycle: [] as string[],
  writes: [] as Array<{ file: string; value: unknown }>,
}));
vi.mock('./scenarioLoader.js', () => ({ loadScenario: mock.load }));
vi.mock('./jsonlSink.js', () => ({
  JsonlSink: class {
    constructor(private file: string) {}
    async write(value: unknown) { mock.writes.push({ file: this.file, value }); }
    async close() {}
  },
  AppendOnlyJsonl: class {
    constructor(private file: string) {}
    async write(value: unknown) { mock.writes.push({ file: this.file, value }); }
  },
}));
vi.mock('@tah/human-sim', () => ({ run: mock.human, campaignSessionStorageEnabled: () => false }));
vi.mock('@tah/trivial-http', () => ({ run: vi.fn(), resolveRedirectFirst: mock.redirect }));
vi.mock('@tah/headless-browser', () => ({ run: vi.fn() }));
vi.mock('@tah/stealth-browser', () => ({ run: vi.fn() }));
vi.mock('@tah/profiles', () => ({ loadProfile: () => ({ id: 'fixture-profile' }) }));
vi.mock('@tah/tz', () => ({ resolveProxyEgress: vi.fn(async () => ({ ip: null, verified: false })) }));

let scenario: Scenario;
let runDir: string;
function event(status = 200, headers: Record<string, string> = {}, finalUrl = 'https://destination.example/?im_ref=fixture%2Fid&sharedid=&im_rewards='): RequestEvent {
  return { scenario_id: 'fixture', repeat_index: 0, tier: 'human', geo_requested: { country: 'US' },
    proxy_mode: 'sticky-residential', started_at: new Date().toISOString(),
    final_landing_url: finalUrl, final_verdict: 'allow', timing: { total_ms: 1 },
    events: [{ url: finalUrl, method: 'GET', status, time_ms: 1, headers, ta_signal: { main_document: 'true' } }] };
}
function browserSteps(steps: Array<RequestEvent | Error>, cleanupFailure = false) {
  mock.human.mockImplementation((_scenario: Scenario, _route: URL) => {
    const index = mock.human.mock.calls.length - 1;
    return (async function* () {
      try {
        const step = steps[index] ?? steps.at(-1)!;
        if (step instanceof Error) throw step;
        yield structuredClone(step);
      } finally {
        mock.lifecycle.push('context-cleaned-' + (index + 1));
        if (cleanupFailure) throw new Error('Browser or route cleanup was not acknowledged; proxy replacement is disabled');
      }
    })();
  });
}
function allocator(options: { releaseFails?: boolean; rotationMode?: string; missing?: boolean } = {}) {
  let count = 0;
  const acquire = vi.fn(async (input: Parameters<ContextProxyAllocator['acquire']>[0]): Promise<CampaignProxyLease | null> => {
    count++;
    mock.lifecycle.push('acquire-' + count);
    if (options.missing) return null;
    return { leaseId: 'lease-' + count, fencingToken: count, providerId: 'fixture', poolId: 'fixture',
      endpointKey: 'endpoint-' + count, proxyUrl: 'http://fixture:session-' + input.sessionId + '@proxy.example:1000',
      protocol: 'http', rotationMode: options.rotationMode ?? 'sticky-session', leaseTtlMs: 60000, fallbackUsed: false };
  });
  const release = vi.fn(async (lease: CampaignProxyLease, _outcome: ContextProxyOutcome) => {
    mock.lifecycle.push('release-' + lease.leaseId.replace('lease-', ''));
    if (options.releaseFails) throw new Error('release not acknowledged');
  });
  return { acquire, release };
}
async function execute(proxyAllocator: ContextProxyAllocator, overrides: Partial<Parameters<typeof runScenario>[0]> = {}) {
  const capture = vi.fn(), rejected = vi.fn(), emit = vi.fn();
  const running = runScenario({ scenarioFile: 'fixture-only.yaml', runDir, bus: { emit } as unknown as EventBus,
    creds: { user: 'fixture', pass: 'not-real' }, runId: 'fixture-run', proxyAllocator,
    onCapture: capture, onCaptureRejected: rejected, ...overrides });
  // Advance only this fixture's bounded replacement delay, not long edge waits.
  const settled = running.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(1001);
  const outcome = await settled;
  if (outcome.error) throw outcome.error;
  return { capture, rejected, emit };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
  vi.stubEnv('TAH_NO_PROXY', '0'); vi.stubEnv('TAH_REDIRECT_FIRST_ENABLED', '0');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  mock.load.mockReset(); mock.human.mockReset(); mock.redirect.mockReset();
  mock.lifecycle.length = 0; mock.writes.length = 0;
  runDir = mkdtempSync(join(tmpdir(), 'tah-transport-fixture-'));
  scenario = { id: 'fixture',
    tier: 'human', seed_url: 'https://tracker.example/start', geo: { country: 'US' },
    proxy_mode: 'rotating-residential', repeats: 1, verdict_detection: { challenge_signatures: [] } };
  mock.load.mockResolvedValue(scenario);
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  // Only a fresh empty directory is created; no recursive cleanup or app data.
  rmdirSync(runDir);
});

describe('proxy reporting is separate from retry eligibility', () => {
  it('labels a browser proxy connection error correctly without authorizing failover', () => {
    const message = 'page.goto: net::ERR_PROXY_CONNECTION_FAILED';
    expect(classifyAttemptOutcome(false, message).failureDomain).toBe('proxy');
    expect(isProxyTransportFailure(message)).toBe(false);
    expect(isProxyTransportFailure(new ProxyTransportError('connection_refused'))).toBe(true);
  });
  it('keeps target rejection and cancellation ahead of proxy-like text', () => {
    expect(classifyAttemptOutcome(false, 'Target rejected capture: ERR_PROXY_CONNECTION_FAILED').failureDomain).toBe('target');
    expect(classifyAttemptOutcome(false, 'ERR_PROXY_CONNECTION_FAILED', true).failureDomain).toBe('cancelled');
    expect(classifyAttemptOutcome(true, 'ERR_PROXY_CONNECTION_FAILED').healthy).toBe(true);
  });
});

describe('orchestrator transport-only failover', () => {
  it('uses at most one new sticky session after cleanup of a confirmed pre-response failure', async () => {
    browserSteps([new ProxyTransportError('connection_refused'), event()]);
    const pool = allocator(), result = await execute(pool);
    expect(mock.human).toHaveBeenCalledTimes(2);
    expect(pool.acquire).toHaveBeenCalledTimes(2);
    expect(pool.release).toHaveBeenCalledTimes(2);
    expect(pool.acquire.mock.calls[0]![0].sessionId).not.toBe(pool.acquire.mock.calls[1]![0].sessionId);
    expect(mock.human.mock.calls.every(call => call[0].proxy_mode === 'sticky-residential')).toBe(true);
    expect(mock.lifecycle).toEqual(['acquire-1', 'context-cleaned-1', 'release-1', 'acquire-2', 'context-cleaned-2', 'release-2']);
    expect(result.capture).toHaveBeenCalledTimes(1);
    expect(result.capture.mock.calls[0]![0].final_landing_url).toBe(event().final_landing_url);
  });
  it('stops after two confirmed transport failures', async () => {
    browserSteps([new ProxyTransportError('node_unavailable')]);
    const pool = allocator(), result = await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(2);
    expect(pool.release).toHaveBeenCalledTimes(2);
    expect(result.capture).not.toHaveBeenCalled();
  });
  it.each(['ERR_PROXY_CONNECTION_FAILED', 'ERR_CERT_AUTHORITY_INVALID', 'HTTP 407',
    'navigation timeout', 'Campaign session storage: database unavailable', 'unknown application failure'])('does not rotate for untrusted failure text: %s', async message => {
    browserSteps([new Error(message)]);
    const pool = allocator();
    await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(mock.human).toHaveBeenCalledTimes(1);
  });
  it.each([403, 429])('does not rotate or capture after HTTP %s', async status => {
    browserSteps([event(status, { 'retry-after': '3600', 'cf-ray': '0123456789abcdef-DEL' })]);
    const pool = allocator(), result = await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(result.capture).not.toHaveBeenCalled();
    expect(result.rejected).toHaveBeenCalledTimes(1);
    expect(result.rejected.mock.calls[0]![0]).toMatchObject({ accepted: false, retry: { delayMs: 3600000 } });
    expect(pool.release.mock.calls[0]![1].failureDomain).toBe('target');
  });
  it('rejects challenge query bytes even on a nominal HTTP 200', async () => {
    browserSteps([event(200, {}, 'https://tracker.example/start?__cf_chl_rt_tk=fixture')]);
    const pool = allocator(), result = await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(result.capture).not.toHaveBeenCalled();
    expect(result.rejected.mock.calls[0]![0]).toMatchObject({ code: 'cloudflare_challenge' });
  });
  it('never replays a journey that already received a redirect response', async () => {
    const failed = event(302, { location: 'https://destination.example/landing' }, scenario.seed_url);
    failed.error = new ProxyTransportError('connection_reset').message;
    browserSteps([failed]);
    const pool = allocator(), result = await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(result.capture).not.toHaveBeenCalled();
  });
  it('requires acknowledged lease release before any replacement', async () => {
    browserSteps([new ProxyTransportError('connection_refused')]);
    const pool = allocator({ releaseFails: true });
    await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
  });
  it('refuses replacement when the previous context cleanup fails', async () => {
    browserSteps([new ProxyTransportError('connection_refused')], true);
    const pool = allocator();
    await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
  });
  it.each([{ rotationMode: 'per-request' }])('rejects an unsafe registry policy', async options => {
    browserSteps([event()]);
    const pool = allocator(options);
    await execute(pool);
    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(mock.human).not.toHaveBeenCalled();
  });
});

describe('rate-limit and release acknowledgements', () => {
  it('honors a long Retry-After without shortening it to one five-minute chunk', () => {
    const now = Date.now(), backoff = new CaptureBackoff();
    const decision = evaluateCaptureResult(event(429, { 'retry-after': '3600' }));
    expect(backoff.observe(decision, now)).toMatchObject({ retry: { notBefore: now + 3600000, delayMs: 3600000 } });
    expect(backoff.remainingMs(now)).toBe(300000);
    expect(backoff.remainingMs(now + 300000)).toBe(300000);
    expect(backoff.remainingMs(now + 3599999)).toBe(1);
    expect(backoff.remainingMs(now + 3600000)).toBe(0);
  });
  it('honors an HTTP-date Retry-After and ignores malformed header text', () => {
    const now = Date.now();
    const dated = evaluateCaptureResult(event(429, { 'retry-after': new Date(now + 900000).toUTCString() }));
    expect(new CaptureBackoff().observe(dated, now)).toMatchObject({ retry: { delayMs: 900000 } });
    const invalid = evaluateCaptureResult(event(429, { 'retry-after': 'not-a-delay' }));
    expect(new CaptureBackoff().observe(invalid, now)).toMatchObject({ retry: { delayMs: 60000 } });
  });
  it('fails closed on an unacknowledged runtime release, without a network request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(releaseCampaignProxy({ enabled: true, token: 'fixture', leaseId: 'fixture',
      baseUrl: 'http://127.0.0.1:1/never-contacted', fetchImpl })).rejects.toThrow('not acknowledged');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
