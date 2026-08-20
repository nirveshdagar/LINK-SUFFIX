// Per-page behavioral event recorder. Captures mouse moves, clicks, scrolls,
// keypresses, focus events, and hover events with millisecond timestamps from
// page navigation start. Output is one JSON object per event to a JSONL sink;
// a final flush() writes a summary line with derived statistics.
//
// Designed to be attached to a Playwright page via page.on(...) wrappers �
// see packages/tiers/human-sim for wiring.

import { writeFileSync } from 'node:fs';

export type TelemetryEvent =
  | { type: 'mouse_move'; t: number; x: number; y: number }
  | { type: 'click'; t: number; x: number; y: number; button: 'left' | 'right' | 'middle'; target: string }
  | { type: 'scroll'; t: number; deltaY: number; x: number; y: number }
  | { type: 'keypress'; t: number; key: string; intervalMs: number }
  | { type: 'focus'; t: number; focused: boolean }
  | { type: 'hover'; t: number; x: number; y: number; target: string };

export interface PageSummary {
  page_url: string;
  started_at: number;
  duration_ms: number;
  event_count: number;
  mouse_move_count: number;
  click_count: number;
  scroll_count: number;
  keypress_count: number;
  mouse_velocity_avg: number;
  mouse_velocity_max: number;
  click_intervals: number[];
}

export class TelemetryRecorder {
  private events: TelemetryEvent[] = [];
  private startedAt = Date.now();
  private pageUrl: string;
  private lastKeyTime = 0;

  constructor(pageUrl: string) {
    this.pageUrl = pageUrl;
  }

  record(event: Record<string, unknown>, baseT = Date.now()): void {
    this.events.push({ ...event, t: baseT } as TelemetryEvent);
  }

  recordMouseMove(x: number, y: number): void {
    this.record({ type: 'mouse_move', x, y });
  }
  recordClick(x: number, y: number, button: 'left' | 'right' | 'middle', target: string): void {
    this.record({ type: 'click', x, y, button, target });
  }
  recordScroll(deltaY: number, x: number, y: number): void {
    this.record({ type: 'scroll', deltaY, x, y });
  }
  recordKeypress(key: string): void {
    const now = Date.now();
    const intervalMs = this.lastKeyTime ? now - this.lastKeyTime : 0;
    this.lastKeyTime = now;
    this.record({ type: 'keypress', key, intervalMs });
  }
  recordFocus(focused: boolean): void {
    this.record({ type: 'focus', focused });
  }
  recordHover(x: number, y: number, target: string): void {
    this.record({ type: 'hover', x, y, target });
  }

  /**
   * Convert the accumulated events to JSONL lines. Each line is one event;
   * the final line is the summary with derived statistics.
   */
  flush(): string {
    const endedAt = Date.now();
    const lines = this.events.map((e) => JSON.stringify(e));
    lines.push(JSON.stringify(this.buildSummary(endedAt)));
    return lines.join('\n') + '\n';
  }

  writeToFile(path: string): void {
    writeFileSync(path, this.flush());
  }

  buildSummary(endedAt: number): PageSummary {
    const moves = this.events.filter((e) => e.type === 'mouse_move') as Array<Extract<TelemetryEvent, { type: 'mouse_move' }>>;
    let totalV = 0, maxV = 0;
    for (let i = 1; i < moves.length; i++) {
      const dt = (moves[i]!.t - moves[i - 1]!.t) || 1;
      const dx = moves[i]!.x - moves[i - 1]!.x;
      const dy = moves[i]!.y - moves[i - 1]!.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const v = dist / dt;
      totalV += v;
      if (v > maxV) maxV = v;
    }
    const clicks = this.events.filter((e) => e.type === 'click') as Array<Extract<TelemetryEvent, { type: 'click' }>>;
    const scrollCount = this.events.filter((e) => e.type === 'scroll').length;
    const keypresses = this.events.filter((e) => e.type === 'keypress') as Array<Extract<TelemetryEvent, { type: 'keypress' }>>;
    return {
      page_url: this.pageUrl,
      started_at: this.startedAt,
      duration_ms: endedAt - this.startedAt,
      event_count: this.events.length,
      mouse_move_count: moves.length,
      click_count: clicks.length,
      scroll_count: scrollCount,
      keypress_count: keypresses.length,
      mouse_velocity_avg: moves.length > 1 ? totalV / (moves.length - 1) : 0,
      mouse_velocity_max: maxV,
      click_intervals: clicks.map((c, i) => i === 0 ? 0 : c.t - clicks[i - 1]!.t),
    };
  }
}
