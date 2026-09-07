import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@tah/contracts';
import { edgeStopForResponse } from '@tah/contracts';
import { ProxyResponseError, ProxyTransportError } from '@tah/proxy';
import { resolveRedirectFirst } from './redirectResolver.js';

const mock = vi.hoisted(() => ({ fire: vi.fn() }));
vi.mock('./ja3.js', () => ({ fireWithJa3: mock.fire }));
vi.mock('@tah/proxy', async () => {
  const actual = await vi.importActual<typeof import('@tah/proxy')>('@tah/proxy');
  return { ...actual, resolvePublicAddress: vi.fn(async () => '1.1.1.1') };
});

const proxy = new URL('http://fixture:session-one@proxy.example:1000');
const scenario: Scenario = {
  id: 'redirect-fixture', tier: 'human',
  seed_url: 'https://tracker.example/start', geo: { country: 'US' },
  proxy_mode: 'sticky-residential', repeats: 1, session: { follow_external_redirects: true },
};
function response(status: number, headers: Record<string, string> = {}) {
  return { status, headers, body: Buffer.alloc(0), fp: {}, bodyCaptureState: 'unavailable' };
}
beforeEach(() => mock.fire.mockReset());

describe('redirect-first transport and edge policy', () => {
  it('keeps one proxy session and exact query bytes through normal redirects', async () => {
    const finalUrl = 'https://destination.example/?im_ref=a%2Fb&x=+&x=%20&sharedid=&im_rewards=';
    mock.fire.mockResolvedValueOnce(response(302, { location: 'https://tracker.example/second' }))
      .mockResolvedValueOnce(response(307, { location: finalUrl }))
      .mockResolvedValueOnce(response(200));
    const result = await resolveRedirectFirst(scenario, proxy, {});
    expect(result).toMatchObject({ outcome: 'captured', finalUrl });
    expect(mock.fire).toHaveBeenCalledTimes(3);
    expect(mock.fire.mock.calls.every(call => call[1] === proxy)).toBe(true);
  });
  it.each([403, 429])('stops HTTP %s without declaring a browser fallback', async status => {
    mock.fire.mockResolvedValueOnce(response(status, { 'retry-after': '120' }));
    const result = await resolveRedirectFirst(scenario, proxy, {});
    expect(result.outcome).toBe('stopped');
    expect(mock.fire).toHaveBeenCalledTimes(1);
    expect(edgeStopForResponse(result.events[0])).toMatchObject({ accepted: false, diagnostics: { httpStatus: status, retryAfterMs: 120000 } });
  });
  it('stops a challenge Location before following it', async () => {
    mock.fire.mockResolvedValueOnce(response(302, { location: '/start?%5F%5Fcf_chl_rt_tk=fixture' }));
    const result = await resolveRedirectFirst(scenario, proxy, {});
    expect(result.outcome).toBe('stopped');
    expect(mock.fire).toHaveBeenCalledTimes(1);
    expect(edgeStopForResponse(result.events[0])).toMatchObject({ code: 'cloudflare_challenge' });
  });
  it('does not send an initial challenge-token URL', async () => {
    const result = await resolveRedirectFirst({ ...scenario, seed_url: scenario.seed_url + '?__cf_chl_rt_tk=fixture' }, proxy, {});
    expect(result.outcome).toBe('stopped');
    expect(mock.fire).not.toHaveBeenCalled();
  });
  it('recognizes a challenge header even on HTTP 200', async () => {
    mock.fire.mockResolvedValueOnce(response(200, { 'Cf-Mitigated': 'Challenge' }));
    expect((await resolveRedirectFirst(scenario, proxy, {})).outcome).toBe('stopped');
    expect(mock.fire).toHaveBeenCalledTimes(1);
  });
  it('exposes a confirmed pre-response transport outage to the orchestrator', async () => {
    mock.fire.mockRejectedValueOnce(new ProxyTransportError('connection_refused'));
    await expect(resolveRedirectFirst(scenario, proxy, {})).rejects.toMatchObject({ transportCode: 'connection_refused' });
    expect(mock.fire).toHaveBeenCalledTimes(1);
  });
  it('does not authorize a replay after a redirect response', async () => {
    mock.fire.mockResolvedValueOnce(response(302, { location: 'https://destination.example/landing' }))
      .mockRejectedValueOnce(new ProxyTransportError('connection_reset'));
    const result = await resolveRedirectFirst(scenario, proxy, {});
    expect(result.outcome).toBe('stopped');
    expect(result.events).toHaveLength(1);
    expect(mock.fire).toHaveBeenCalledTimes(2);
  });
  it.each(['certificate validation failed', 'request timeout', 'unexpected application error'])('stops unknown/TLS failures: %s', async message => {
    mock.fire.mockRejectedValueOnce(new Error(message));
    expect((await resolveRedirectFirst(scenario, proxy, {})).outcome).toBe('stopped');
    expect(mock.fire).toHaveBeenCalledTimes(1);
  });
  it.each([403, 407, 429])('preserves upstream HTTP %s without transport failover', async status => {
    mock.fire.mockRejectedValueOnce(new ProxyResponseError(status, '60', '0123456789abcdef-DEL'));
    const result = await resolveRedirectFirst(scenario, proxy, {});
    expect(result.outcome).toBe('stopped');
    expect(result.events[0]).toMatchObject({ status, headers: { 'cf-ray': '0123456789abcdef-DEL' } });
    expect(mock.fire).toHaveBeenCalledTimes(1);
  });
});
