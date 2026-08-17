import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlSink } from './jsonlSink.js';

describe('JsonlSink', () => {
  it('appends valid JSONL', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tah-'));
    try {
      const sink = new JsonlSink(path.join(dir, 'a.jsonl'));
      await sink.write({
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
      await sink.close();
      const lines = readFileSync(path.join(dir, 'a.jsonl'), 'utf8').split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).scenario_id).toBe('x');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});