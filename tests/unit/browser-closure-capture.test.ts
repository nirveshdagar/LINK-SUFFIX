import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateCaptureResult } from '@tah/contracts';
import { run } from '../../packages/tiers/human-sim/src/runner.js';
import { isTopLevelNavigation } from '../../packages/tiers/human-sim/src/mainDocument.js';

const mock = vi.hoisted(() => ({ context: null as any, scroll: vi.fn(), release: vi.fn(),
  permitRelease: vi.fn(), routeClose: vi.fn(async () => {}) }));
vi.mock('../../packages/tiers/human-sim/src/browserPool.js', () => ({
  acquireBrowserLease: async () => ({ browser: { newContext: async () => mock.context,
    isConnected: () => true, version: () => 'fixture' }, release: mock.release }),
}));
vi.mock('../../packages/tiers/human-sim/src/browserPermit.js', () => ({
  acquireBrowserPermit: async () => ({ release: mock.permitRelease }),
}));
vi.mock('../../packages/tiers/human-sim/src/behavior/scroll.js', () => ({ humanScroll: mock.scroll }));
vi.mock('../../packages/tiers/human-sim/src/challenge.js', () => ({
  detectChallenge: async () => null, pauseForIntervention: vi.fn(),
}));
vi.mock('@tah/proxy', async importOriginal => ({
  ...await importOriginal<any>(),
  createPublicEgressProxy: async () => ({ proxy: undefined, close: mock.routeClose }),
}));
vi.mock('@tah/ua', () => ({
  templatesForProfile: () => [{ family: 'chrome' }],
  synthesizeUA: () => ({ ua: 'fixture', templateId: 'fixture', fingerprint: {
    timezone: 'America/New_York', viewport: { w: 1280, h: 720, dpr: 1 },
    locale: 'en-US', languages: ['en-US'] } }),
  installFingerprintProfile: async () => {},
}));
vi.mock('@tah/antidetect', () => ({ pickFingerprint: () => ({ id: 'fixture', family: 'fixture' }) }));
vi.mock('@tah/tz', () => ({
  resetTzCache: () => {}, commonTzForLocale: () => 'America/New_York', tzForGeo: () => 'America/New_York',
  resolveProxyEgress: async () => ({ ip: '192.0.2.1', country: 'US', timezone: 'America/New_York', verified: true }),
  verifyProxyEgressStability: async () => ({ ip: '192.0.2.1', country: 'US', timezone: 'America/New_York', verified: true }),
}));
vi.mock('@tah/telemetry', () => ({
  TelemetryRecorder: class {
    recordFrame() {} recordScroll() {} writeToFile() {}
    buildSummary() { return { frame_count: 0, event_count: 0, mouse_move_count: 0,
      click_count: 0, scroll_count: 0, keypress_count: 0, duration_ms: 0,
      mouse_velocity_avg: 0, mouse_velocity_max: 0 }; }
  },
}));

const closedError = () => new Error('mouse.wheel: Target page, context or browser has been closed');
function fixture() {
  const handlers = new Map<string, Array<(value: any) => void>>();
  let routeHandler: (route: any) => Promise<void>;
  let closed = false;
  let current = 'https://destination.example/';
  const page: any = {
    url: () => current, isClosed: () => closed, mainFrame: () => mainFrame,
    waitForLoadState: async () => {}, waitForTimeout: async () => { if (closed) throw closedError(); },
    goto: async (url: string) => {
      current = url;
      emitResponse(200, {}, false);
    },
  };
  const mainFrame: any = { page: () => page };
  const childFrame: any = { page: () => page };
  function request(url: string, child = false) {
    return { url: () => url, method: () => 'GET', isNavigationRequest: () => true,
      headers: () => ({ 'user-agent': 'fixture' }),
      resourceType: () => 'document', frame: () => child ? childFrame : mainFrame };
  }
  function emitResponse(status: number, headers: Record<string, string>, child: boolean, url = current) {
    const req = request(url, child);
    handlers.get('request')?.forEach(fn => fn(req));
    const res = { url: () => url, request: () => req, status: () => status,
      headers: () => headers, allHeaders: async () => headers, body: async () => Buffer.alloc(0) };
    handlers.get('response')?.forEach(fn => fn(res));
  }
  const context: any = {
    exposeBinding: async () => {}, addInitScript: async () => {}, newPage: async () => page,
    close: vi.fn(async () => { closed = true; }),
    on: (name: string, handler: (value: any) => void) => {
      handlers.set(name, [...(handlers.get(name) || []), handler]); return context;
    },
    route: async (_pattern: string, handler: typeof routeHandler) => { routeHandler = handler; },
  };
  mock.context = context;
  return { context, page, request, emitResponse,
    setUrl: (url: string) => { current = url; },
    async navigateChild(url: string) {
      const abort = vi.fn(async () => {}), next = vi.fn(async () => {});
      await routeHandler!({ request: () => request(url, true), abort, continue: next });
      return { abort, next };
    } };
}
const profile = { id: 'fixture', locale: 'en-US', viewport: { w: 1280, h: 720, dpr: 1 },
  hardware: {}, webgl: {}, touch: false } as any;
async function collect(signal?: AbortSignal) {
  const scenario = { id: 'fixture', tier: 'human', seed_url: 'https://destination.example/',
    geo: { country: 'US' }, proxy_mode: 'sticky-residential', continuous: false,
    session: { pages: { min: 1, max: 1 }, headless: true, follow_external_redirects: true },
    __tahRuntime: { signal } } as any;
  const events = [];
  for await (const event of run(scenario, new URL('http://proxy.example:1000'), profile)) events.push(event);
  return events;
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('browser closure diagnostics and document ownership', () => {
  it.each([403, 429, 200])('preserves the original HTTP %s rejection during a scroll race', async status => {
    const f = fixture();
    mock.scroll.mockImplementation(async () => {
      f.emitResponse(status, { 'cf-ray': 'a37602f159327d47-BOS', 'retry-after': '600',
        ...(status === 200 ? { 'cf-mitigated': 'challenge' } : {}) }, false);
      throw closedError();
    });
    const rows = await collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toMatch(/^Target rejected capture:/);
    expect(evaluateCaptureResult(rows[0])).toMatchObject({ accepted: false,
      diagnostics: { hostname: 'destination.example', httpStatus: status, rayId: 'a37602f159327d47-BOS', retryAfterMs: 600000 } });
    expect(mock.scroll).toHaveBeenCalledTimes(1);
    expect(mock.release).toHaveBeenCalledTimes(1);
    expect(mock.permitRelease).toHaveBeenCalledTimes(1);
    expect(mock.routeClose).toHaveBeenCalledTimes(1);
  });

  it('aborts a child challenge URL without closing the destination context', async () => {
    const f = fixture();
    const suffix = 'irclickid=fixture%2Fid&sharedid=&empty=';
    mock.scroll.mockImplementation(async () => {
      const route = await f.navigateChild('https://widget.example/?__cf_chl_rt_tk=fixture');
      expect(route.abort).toHaveBeenCalledOnce();
      expect(f.context.close).not.toHaveBeenCalled();
      f.setUrl('https://destination.example/?' + suffix);
      f.emitResponse(200, {}, false);
    });
    const [row] = await collect();
    expect(row!.error).toBeUndefined();
    expect(evaluateCaptureResult(row)).toMatchObject({ accepted: true, suffix });
    expect(row!.events.some(e => e.url.includes('__cf_chl_rt_tk'))).toBe(false);
  });

  it('does not close the destination context for a child HTTP 403', async () => {
    const f = fixture();
    mock.scroll.mockImplementation(async () => {
      f.emitResponse(403, {}, true, 'https://widget.example/frame');
      expect(f.context.close).not.toHaveBeenCalled();
      f.setUrl('https://destination.example/?click=fixture');
      f.emitResponse(200, {}, false);
    });
    const [row] = await collect();
    expect(evaluateCaptureResult(row)).toMatchObject({ accepted: true, suffix: 'click=fixture' });
    expect(row!.events.find(e => e.url.includes('widget.example'))?.ta_signal.main_document).toBe('false');
  });

  it('retains prior response evidence when the browser closes for an unknown reason', async () => {
    const f = fixture();
    mock.scroll.mockImplementation(async () => { await f.context.close(); throw closedError(); });
    const [row] = await collect();
    expect(row!.events.some(e => e.status === 200 && e.ta_signal.main_document === 'true')).toBe(true);
    expect(evaluateCaptureResult(row)).toMatchObject({ accepted: false, code: 'browser_closed' });
  });

  it('propagates cancellation without manufacturing a capture rejection', async () => {
    fixture(); const controller = new AbortController();
    mock.scroll.mockImplementation(async () => { controller.abort(); throw closedError(); });
    await expect(collect(controller.signal)).rejects.toThrow('closed');
    expect(mock.release).toHaveBeenCalledTimes(1);
  });

  it('only grants document ownership to main frames, including popup main frames', () => {
    const f = fixture();
    expect(isTopLevelNavigation(f.request('https://destination.example/'))).toBe(true);
    expect(isTopLevelNavigation(f.request('https://widget.example/', true))).toBe(false);
    expect(isTopLevelNavigation({ isNavigationRequest: () => true, frame: () => { throw new Error('detached'); } })).toBe(false);
  });
});
