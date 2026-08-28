import { describe, it, expect } from 'vitest';
import { TelemetryRecorder } from './recorder.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('TelemetryRecorder', () => {
  it('records events and flushes to JSONL', () => {
    const r = new TelemetryRecorder('https://example.com/');
    for (let i = 0; i < 10; i++) r.recordMouseMove(i * 10, i * 5);
    r.recordClick(100, 50, 'left', 'a');
    r.recordScroll(120, 50, 60);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tah-tel-'));
    const out = path.join(tmp, 'page.jsonl');
    r.writeToFile(out);
    expect(existsSync(out)).toBe(true);
    const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(12);
  });

  it('builds summary with mouse velocity stats', () => {
    const r = new TelemetryRecorder('https://example.com/');
    for (let i = 0; i < 50; i++) r.recordMouseMove(i * 5, i * 3);
    const s = r.buildSummary(Date.now());
    expect(s.mouse_move_count).toBe(50);
    expect(s.mouse_velocity_max).toBeGreaterThan(0);
  });

  it('retains browser frame and wall-clock timestamps', () => {
    const r = new TelemetryRecorder('https://example.com/');
    r.recordFrame(16.67, 1_700_000_000_000, [{ type: 'mouse_move', x: 10, y: 20 }]);
    const summary = r.buildSummary(1_700_000_000_050);
    expect(summary.frame_count).toBe(1);
    expect(summary.event_count).toBe(1);
  });
});
