import { expect, it } from 'vitest';
import { buildCapturePayload } from './runner.js';
import { evaluateCaptureResult, type RequestEvent, type RedirectCapturePolicy } from '@tah/contracts';

it('carries an approved HTTP intermediary through worker compaction and run-bound control validation', () => {
  const policy: RedirectCapturePolicy = { mode: 'redirect_only', issuer_origin: 'https://affiliate.example',
    destination_origin: 'https://merchant.example', required_parameter: 'irclickid',
    navigation_origins: ['https://tracker.example', 'http://intermediate.example', 'https://affiliate.example'] };
  const url = 'https://merchant.example/?irclickid=exact%2fBytes&sharedid=&im_rewards=';
  const event: RequestEvent = { scenario_id: 'fixture', repeat_index: 0, tier: 'human', geo_requested: { country: 'US' },
    proxy_mode: 'sticky-residential', started_at: '2026-09-07T17:00:00.000Z', final_landing_url: url,
    redirect_capture: policy, final_verdict: 'unsure', timing: { total_ms: 10 }, events: [
      { url: 'http://intermediate.example/click', method: 'GET', status: 307, time_ms: 4,
        headers: { location: 'https://affiliate.example/click' },
        ta_signal: { main_document: 'true', capture_path: 'browser-redirect-only', destination_visited: 'false', egress_guard: 'origin_allowlist' } },
      { url: 'https://affiliate.example/click', method: 'GET', status: 301, time_ms: 10,
        headers: { location: url, 'set-cookie': 'fixture-private-cookie' },
        ta_signal: { main_document: 'true', capture_path: 'browser-redirect-only', destination_visited: 'false', egress_guard: 'origin_allowlist' } },
    ] };
  const payload = buildCapturePayload(event);
  expect(payload.events.map(row => row.status)).toEqual([307, 301]);
  expect(JSON.stringify(payload)).not.toContain('fixture-private-cookie');
  expect(evaluateCaptureResult(payload, { redirectPolicy: policy })).toMatchObject({
    accepted: true, evidence: 'redirect-only', suffix: 'irclickid=exact%2fBytes&sharedid=&im_rewards=' });
  expect(evaluateCaptureResult(payload, {}).accepted).toBe(false);
});
