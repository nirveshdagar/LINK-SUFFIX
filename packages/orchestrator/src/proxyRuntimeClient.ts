export interface CampaignProxyLease {
  leaseId: string;
  fencingToken: number;
  providerId: string;
  poolId: string;
  endpointKey: string;
  proxyUrl: string;
  protocol: string;
  rotationMode: string;
  leaseTtlMs: number;
  fallbackUsed: boolean;
}

interface RuntimeClientOptions {
  enabled: boolean;
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

function runtimeUrl(value?: string) {
  const url = new URL(value?.trim() || 'http://127.0.0.1:3100/api/proxy-runtime');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('TAH_PROXY_RUNTIME_INTERNAL_URL must use HTTP or HTTPS');
  return url.toString();
}

async function callRuntime(options: RuntimeClientOptions, payload: Record<string, unknown>) {
  if (!options.token?.trim()) throw new Error('CONTROL_TOKEN is required for universal proxy runtime');
  const response = await (options.fetchImpl || fetch)(runtimeUrl(options.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token.trim()}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as Record<string, any>;
  return { response, result };
}

export async function leaseCampaignProxy(options: RuntimeClientOptions & { campaignRecordId: string; sessionId: string; geo?: Record<string, unknown> }) {
  if (!options.enabled) return null;
  const { response, result } = await callRuntime(options, { action: 'lease', campaignRecordId: options.campaignRecordId, sessionId: options.sessionId, geo: options.geo });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Universal proxy lease failed: ${String(result.error || `HTTP ${response.status}`)}`);
  const lease = result.lease as CampaignProxyLease | undefined;
  if (!lease?.leaseId || !lease.proxyUrl) throw new Error('Universal proxy runtime returned an invalid lease');
  const proxy = new URL(lease.proxyUrl);
  if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol)) throw new Error('Universal proxy runtime returned an unsupported protocol');
  return lease;
}

export async function renewCampaignProxy(options: RuntimeClientOptions & { leaseId: string; ttlMs: number }) {
  if (!options.enabled) return false;
  const { response } = await callRuntime(options, { action: 'renew', leaseId: options.leaseId, ttlMs: options.ttlMs });
  return response.ok;
}

export async function reportCampaignProxy(options: RuntimeClientOptions & { leaseId: string; healthy: boolean; reason?: string; proxyLatencyMs?: number; payloadBytes?: number; browserCpuMs?: number; browserMemoryBytes?: number; redisLatencyMs?: number }) {
  if (!options.enabled) return;
  await callRuntime(options, { action: 'report', leaseId: options.leaseId, healthy: options.healthy, reason: options.reason, proxyLatencyMs: options.proxyLatencyMs, payloadBytes: options.payloadBytes, browserCpuMs: options.browserCpuMs, browserMemoryBytes: options.browserMemoryBytes, redisLatencyMs: options.redisLatencyMs });
}

export async function releaseCampaignProxy(options: RuntimeClientOptions & { leaseId: string; state?: string }) {
  if (!options.enabled) return;
  await callRuntime(options, { action: 'release', leaseId: options.leaseId, state: options.state || 'released' });
}
