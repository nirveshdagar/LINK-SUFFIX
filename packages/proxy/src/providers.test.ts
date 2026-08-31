import { describe, expect, it } from 'vitest';
import {
  ProxyAdapterRegistry,
  advanceProxyCircuit,
  proxyCircuitAllowsRequest,
  recordProxyCircuitResult,
  summarizeProxyMetrics,
  validateProxyProvider,
  type ProxyCircuitState,
  type ProxyProviderDefinition,
} from './index.js';

const universal: ProxyProviderDefinition = {
  id: 'universal-residential-1',
  name: 'Universal Residential',
  kind: 'universal',
  enabled: true,
  protocol: 'http',
  host: 'gateway.example.net',
  ports: [12_000, 12_001],
  authMode: 'username-password',
  usernameTemplate: '{username}-country-{country}-state-{state}-city-{city}-session-{sessionId}',
  passwordTemplate: '{password}',
  rotationModes: ['per-request', 'sticky-session', 'port-pool'],
  capabilities: { country: true, state: true, city: true, stickySession: true, maximumSessionSeconds: 7_200 },
};

describe('universal residential provider adapter', () => {
  it('builds an authenticated HTTP endpoint from provider templates', () => {
    const endpoint = new ProxyAdapterRegistry().buildEndpoint(
      universal,
      { username: 'account', password: 'secret' },
      { campaignId: 'campaign-000001', geo: { country: 'US', state: 'New York', city: 'New York' }, rotationMode: 'sticky-session', sessionId: 'session-01', ttlSeconds: 3_600, port: 12_001 },
    );
    expect(endpoint.url.protocol).toBe('http:');
    expect(endpoint.url.hostname).toBe('gateway.example.net');
    expect(endpoint.url.port).toBe('12001');
    expect(endpoint.url.username).toBe('account-country-us-state-new-york-city-new-york-session-session-01');
    expect(endpoint.url.password).toBe('secret');
    expect(endpoint.mode).toBe('sticky-residential');
  });

  it('supports SOCKS5 token authentication without provider-specific code', () => {
    const provider = { ...universal, id: 'socks-provider', protocol: 'socks5' as const, authMode: 'token' as const, usernameTemplate: '{token}', passwordTemplate: '' };
    const endpoint = new ProxyAdapterRegistry().buildEndpoint(provider, { token: 'token-value' }, {
      campaignId: 'campaign-000002', geo: { country: 'DE' }, rotationMode: 'per-request',
    });
    expect(endpoint.url.protocol).toBe('socks5:');
    expect(endpoint.url.username).toBe('token-value');
    expect(endpoint.url.password).toBe('');
  });

  it('rejects unsupported capabilities, ports, and malformed templates', () => {
    const registry = new ProxyAdapterRegistry();
    expect(() => registry.buildEndpoint({ ...universal, capabilities: { country: true } }, { username: 'a', password: 'b' }, {
      campaignId: 'campaign-1', geo: { country: 'US', city: 'Austin' }, rotationMode: 'per-request',
    })).toThrow(/city targeting/);
    expect(() => registry.buildEndpoint(universal, { username: 'a', password: 'b' }, {
      campaignId: 'campaign-1', geo: { country: 'US' }, rotationMode: 'per-request', port: 9_999,
    })).toThrow(/not part/);
    expect(() => validateProxyProvider({ ...universal, usernameTemplate: '{arbitrary}' })).toThrow(/unsupported token/);
  });

  it('keeps the IPRoyal adapter compatible with the established password grammar', () => {
    const provider: ProxyProviderDefinition = {
      ...universal, id: 'iproyal-default', name: 'IPRoyal', kind: 'iproyal', host: 'geo.iproyal.com', ports: [12_321],
      usernameTemplate: undefined, passwordTemplate: undefined, rotationModes: ['per-request', 'sticky-session'],
    };
    const endpoint = new ProxyAdapterRegistry().buildEndpoint(provider, { username: 'iproyal1365', password: 'basePass' }, {
      campaignId: 'campaign-1', geo: { country: 'US', state: 'CA', city: 'Los Angeles' }, rotationMode: 'sticky-session', sessionId: 'sess0001',
    });
    expect(endpoint.url.username).toBe('iproyal1365');
    expect(endpoint.url.password).toBe('basePass_country-us_state-california_city-los-angeles_session-sess0001_lifetime-1h');
  });
});

describe('provider circuit breaker', () => {
  it('opens after sustained failures and recovers through half-open probes', () => {
    let state: ProxyCircuitState = { state: 'closed', consecutiveFailures: 0, halfOpenSuccesses: 0 };
    for (let index = 0; index < 4; index += 1) state = recordProxyCircuitResult(state, false, index * 1_000);
    expect(state.state).toBe('closed');
    state = recordProxyCircuitResult(state, false, 4_000);
    expect(state.state).toBe('open');
    expect(proxyCircuitAllowsRequest(state, 63_999)).toBe(false);
    state = advanceProxyCircuit(state, 64_000);
    expect(state.state).toBe('half-open');
    state = recordProxyCircuitResult(state, true, 64_001);
    expect(state.state).toBe('half-open');
    state = recordProxyCircuitResult(state, true, 64_002);
    expect(state.state).toBe('closed');
  });
});

describe('proxy performance metrics', () => {
  it('summarizes latency, payload, browser, database, and Redis pressure', () => {
    const summary = summarizeProxyMetrics([
      { success: true, latencyMs: 10, requestBytes: 100, responseBytes: 500, browserCpuMs: 5, browserMemoryBytes: 1_000, databaseLatencyMs: 2, redisLatencyMs: 1 },
      { success: true, latencyMs: 20, requestBytes: 200, responseBytes: 700, browserCpuMs: 7, browserMemoryBytes: 2_000, databaseLatencyMs: 4, redisLatencyMs: 2 },
      { success: false, latencyMs: 100, requestBytes: 50, responseBytes: 0, browserCpuMs: 1, browserMemoryBytes: 3_000, databaseLatencyMs: 10, redisLatencyMs: 8 },
    ]);
    expect(summary.successRate).toBeCloseTo(2 / 3);
    expect(summary.latencyMs).toEqual({ p50: 20, p95: 100, p99: 100 });
    expect(summary.payloadBytes).toEqual({ request: 350, response: 1_200 });
    expect(summary.browser).toEqual({ cpuMs: 13, memoryP95Bytes: 3_000 });
    expect(summary.databaseLatencyP95Ms).toBe(10);
    expect(summary.redisLatencyP95Ms).toBe(8);
  });
});
