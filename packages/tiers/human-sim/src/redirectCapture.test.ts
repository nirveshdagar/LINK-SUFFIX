import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario, RequestEvent } from '@tah/contracts';
import type { DeviceProfile } from '@tah/profiles';
const state = vi.hoisted(() => ({
  responses: [] as Array<{ url: string; status: number; headers: Record<string, string> }>,
  context: undefined as any, closeGuard: vi.fn(async () => undefined), release: vi.fn(), releasePermit: vi.fn(),
  createGuard: vi.fn(), onGoto: undefined as (() => void) | undefined,
}));
vi.mock('@tah/tz', () => ({ verifyProxyEgressStability: vi.fn(async () => ({
  verified: true, ip: '8.8.8.8', country: 'US', timezone: 'America/New_York', provider: 'fixture',
})) }));
vi.mock('@tah/ua', () => ({ templatesForProfile: () => [{ family: 'safari' }] }));
vi.mock('./browserPermit.js', () => ({ acquireBrowserPermit: async () => ({ release: state.releasePermit, slot: 0 }) }));
vi.mock('./browserPool.js', () => ({ acquireBrowserLease: async () => ({
  browser: { newContext: vi.fn(async () => state.context) }, release: state.release,
}) }));
vi.mock('@tah/proxy', async importOriginal => {
  const actual = await importOriginal<typeof import('@tah/proxy')>();
  return { ...actual, createPublicEgressProxy: (...args: unknown[]) => {
    state.createGuard(...args);
    return Promise.resolve({ proxy: { server: 'http://127.0.0.1:1234' }, close: state.closeGuard });
  } };
});
import { runRedirectCapture } from './redirectCapture.js';
import { evaluateCaptureResult } from '@tah/contracts';

const policy = { mode: 'redirect_only' as const, issuer_origin: 'https://affiliate.example', destination_origin: 'https://merchant.example',
  required_parameter: 'irclickid' as const, navigation_origins: ['https://tracker.example', 'https://affiliate.example'] };
const scenario: Scenario = { id: 'fixture', tier: 'human', seed_url: 'https://tracker.example/start', geo: { country: 'US' },
  proxy_mode: 'sticky-residential', repeats: 1, continuous: true, redirect_capture: policy };
const device = { id: 'fixture', locale: 'en-US', viewport: { w: 1280, h: 720, dpr: 1 } } as DeviceProfile;
async function collect(signal?: AbortSignal): Promise<RequestEvent[]> {
  const output: RequestEvent[] = [];
  for await (const event of runRedirectCapture(scenario, new URL('http://proxy.example:1000'), device, { signal })) output.push(event);
  return output;
}
beforeEach(() => {
  vi.clearAllMocks(); state.onGoto = undefined;
  state.responses = [{ url: policy.issuer_origin + '/click', status: 301,
    headers: { location: policy.destination_origin + '/?irclickid=real%2Fvalue&sharedid=' } }];
  const ctx = new EventEmitter() as any;
  ctx.route = vi.fn(async () => undefined);
  ctx.close = vi.fn(async () => { ctx.emit('close'); });
  const frame: any = { parentFrame: () => null, page: () => ({ mainFrame: () => frame }) };
  ctx.newPage = vi.fn(async () => ({ goto: vi.fn(async () => {
    state.onGoto?.();
    for (const row of state.responses) {
      const req = { isNavigationRequest: () => true, resourceType: () => 'document', frame: () => frame,
        url: () => row.url, method: () => 'GET', headers: () => ({ 'user-agent': 'native-fixture' }) };
      ctx.emit('response', { request: () => req, url: () => row.url, status: () => row.status, headers: () => row.headers });
    }
    return null;
  }) }));
  state.context = ctx;
});
describe('isolated browser redirect capture', () => {
  it('captures approved metadata and closes resources without visiting a destination', async () => {
    const rows = await collect();
    expect(evaluateCaptureResult(rows[0])).toMatchObject({ accepted: true, evidence: 'redirect-only' });
    expect(rows[0]?.timing.pages_visited).toBe(0);
    expect(state.createGuard.mock.calls[0]?.[1]).toMatchObject({ allowedOrigins: policy.navigation_origins });
    expect(state.createGuard.mock.calls[0]?.[1].allowedOrigins).not.toContain(policy.destination_origin);
    expect(state.context.close).toHaveBeenCalledOnce(); expect(state.closeGuard).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce(); expect(state.releasePermit).toHaveBeenCalledOnce();
  });
  it.each([403, 429])('stops on HTTP %s without accepting a later redirect or replacing the route', async status => {
    state.responses.unshift({ url: 'https://tracker.example/start', status,
      headers: { 'cf-ray': 'a37602f159327d47-BOS', 'retry-after': '90' } });
    const rows = await collect();
    expect(evaluateCaptureResult(rows[0])).toMatchObject({ accepted: false, diagnostics: { httpStatus: status } });
    expect(state.createGuard).toHaveBeenCalledOnce();
  });
  it('rejects explicit challenges even with HTTP 200', async () => {
    state.responses.unshift({ url: 'https://tracker.example/start', status: 200, headers: { 'cf-mitigated': 'challenge' } });
    expect(evaluateCaptureResult((await collect())[0])).toMatchObject({ accepted: false, code: 'cloudflare_challenge' });
  });
  it('rejects an incomplete redirect and does not substitute a historical tracking ID', async () => {
    state.responses[0]!.headers.location = policy.destination_origin + '/?irclickid=&sharedid=';
    expect(evaluateCaptureResult((await collect())[0]).accepted).toBe(false);
  });
  it('cleans up a cancelled attempt and never yields an accepted capture', async () => {
    const controller = new AbortController();
    state.onGoto = () => controller.abort();
    await expect(collect(controller.signal)).rejects.toThrow('aborted');
    expect(state.context.close).toHaveBeenCalledOnce(); expect(state.closeGuard).toHaveBeenCalledOnce();
    expect(state.releasePermit).toHaveBeenCalledOnce();
  });
  it('rejects before acquiring any browser when policy or entry mode is incompatible', async () => {
    const generator = runRedirectCapture({ ...scenario, redirect_capture: undefined }, new URL('http://proxy.example'), device);
    await expect(generator[Symbol.asyncIterator]().next()).rejects.toThrow('explicit');
    expect(state.createGuard).not.toHaveBeenCalled();
  });
});
