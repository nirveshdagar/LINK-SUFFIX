import { describe, expect, it } from 'vitest';
import { createContextProxySessionId } from '../../packages/orchestrator/src/runner.js';
import { proxyRouteIdentity } from '../../packages/tiers/human-sim/src/browserPool.js';

describe('per-context proxy identity', () => {
  it('creates a fresh IPRoyal-compatible session token for every context', () => {
    const ids = Array.from({ length: 5_000 }, (_, repeatIndex) => createContextProxySessionId({
      scenarioId: 'campaign-000001',
      runId: 'run-shared-worker',
      repeatIndex,
      attemptIndex: 0,
    }));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-f0-9]{8}$/.test(id))).toBe(true);
  });

  it('distinguishes proxy credentials without exposing them as the route key', () => {
    const firstIdentity = proxyRouteIdentity(new URL('http://account:secret_session-aaaaaaaa@gateway.example:12321'));
    const secondIdentity = proxyRouteIdentity(new URL('http://account:secret_session-bbbbbbbb@gateway.example:12321'));
    expect(firstIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(secondIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(firstIdentity).not.toBe(secondIdentity);
    expect(firstIdentity).not.toContain('secret');
  });
});
