import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './eventBus.js';

describe('EventBus', () => {
  it('forwards emits to subscribers', () => {
    const bus = new EventBus();
    const cb = vi.fn();
    bus.on('request', cb);
    bus.emit('request', {
      scenario_id: 'x',
      repeat_index: 0,
      tier: 'trivial-http',
      geo_requested: { country: 'US' },
      proxy_mode: 'rotating-residential',
      started_at: 'x',
      events: [],
      final_verdict: 'allow',
      timing: { total_ms: 0 },
    });
    expect(cb).toHaveBeenCalledOnce();
  });
});