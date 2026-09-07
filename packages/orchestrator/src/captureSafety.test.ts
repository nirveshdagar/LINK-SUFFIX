import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@tah/contracts';
import { evaluateCaptureResult } from '@tah/contracts';
import { buildCapturePayload } from './runner.js';

describe('capture transport safety', () => {
  const url = 'https://www.udemy.com/?im_ref=fresh%2Fvalue&sharedid=&im_rewards=';
  const event = { final_landing_url: url, final_verdict: 'allow', session_id: 'fixture',
    events: [{ url, method: 'GET', status: 200, time_ms: 1,
      headers: { 'set-cookie': 'private=do-not-transport', 'content-type': 'text/html' },
      ta_signal: { main_document: 'true' } }] } as unknown as RequestEvent;
  it('retains validation evidence without carrying cookies through IPC', () => {
    const payload = buildCapturePayload(event);
    expect(evaluateCaptureResult(payload).accepted).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('do-not-transport');
    expect(payload.events).toHaveLength(1);
    expect(payload.final_landing_url).toBe(url);
  });
  it('refuses to turn the live blocked result into a capture message', () => {
    expect(() => buildCapturePayload({ ...event, final_verdict: 'block',
      final_landing_url: 'https://trk.udemy.com/0GMebJ?__cf_chl_rt_tk=fixture' })).toThrow(/Cloudflare/);
  });
  it('does not silently drop rejection state or substitute an old URL', () => {
    expect(() => buildCapturePayload({ ...event, final_verdict: 'challenge' })).toThrow(/blocked/);
    expect(() => buildCapturePayload({ ...event, events: [] })).toThrow(/main-document/);
  });
});
