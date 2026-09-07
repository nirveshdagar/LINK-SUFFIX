import { describe, expect, it } from 'vitest';
import { buildCapturePayload } from '../../packages/orchestrator/src/runner.js';
import type { RequestEvent } from '@tah/contracts';

describe('shared capture payload', () => {
  it('preserves verified proxy egress provenance for Fleet persistence', () => {
    const geoResolved = {
      ip: '98.26.88.33',
      country: 'US',
      state: 'NC',
      city: 'Kannapolis',
      timezone: 'America/New_York',
      asn: 11426,
      organization: 'Charter Communications Inc',
      isp: 'Charter Communications Inc',
      intelligence_provider: 'ipwhois',
      observed_at: '2026-09-04T01:09:46.010Z',
      confidence: 'stable_session' as const,
      verified: true,
    };
    const event = {
      final_landing_url: 'https://example.com/?click=abc',
      final_verdict: 'allow',
      events: [{ url: 'https://example.com/?click=abc', method: 'GET', status: 200, time_ms: 1, headers: {}, ta_signal: { main_document: 'true' } }],
      session_id: 'session-1',
      repeat_index: 7,
      geo_resolved: geoResolved,
      proxy_mode: 'sticky-residential',
    } as RequestEvent;

    expect(buildCapturePayload(event)).toEqual({
      final_landing_url: event.final_landing_url,
      final_verdict: 'allow', challenge: undefined, error: undefined,
      events: [{ ...event.events[0]!, ta_signal: { main_document: 'true', capture_path: '' } }],
      session_id: 'session-1',
      repeat_index: 7,
      geo_resolved: geoResolved,
      proxy_mode: 'sticky-residential',
    });
  });
});
