import { describe, expect, it, vi } from 'vitest';
import { leaseCampaignProxy, releaseCampaignProxy, renewCampaignProxy } from './proxyRuntimeClient.js';

function response(status: number, payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }));
}

describe('universal proxy runtime client', () => {
  it('does not contact runtime while compatibility mode is active', async () => {
    const fetchImpl = vi.fn();
    await expect(leaseCampaignProxy({ enabled: false, token: '', campaignRecordId: 'campaign-1', sessionId: 'run-1', fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats an unassigned campaign as a legacy IPRoyal campaign', async () => {
    const fetchImpl = vi.fn(() => response(404, { error: 'no policy' }));
    await expect(leaseCampaignProxy({ enabled: true, token: 'token', campaignRecordId: 'campaign-1', sessionId: 'run-1', fetchImpl: fetchImpl as typeof fetch })).resolves.toBeNull();
  });

  it('accepts a validated proxy lease and renews/releases it', async () => {
    const lease = { leaseId: 'lease-1', fencingToken: 1, providerId: 'provider', poolId: 'pool', endpointKey: 'gate:1000', proxyUrl: 'http://user:pass@gate.example:1000/', protocol: 'http', rotationMode: 'sticky-session', leaseTtlMs: 180000, fallbackUsed: false };
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => response(201, { lease }))
      .mockImplementationOnce(() => response(200, { lease }))
      .mockImplementationOnce(() => response(200, { ok: true }));
    await expect(leaseCampaignProxy({ enabled: true, token: 'token', campaignRecordId: 'campaign-1', sessionId: 'run-1', fetchImpl: fetchImpl as typeof fetch })).resolves.toEqual(lease);
    await expect(renewCampaignProxy({ enabled: true, token: 'token', leaseId: 'lease-1', ttlMs: 180000, fetchImpl: fetchImpl as typeof fetch })).resolves.toBe(true);
    await releaseCampaignProxy({ enabled: true, token: 'token', leaseId: 'lease-1', fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
