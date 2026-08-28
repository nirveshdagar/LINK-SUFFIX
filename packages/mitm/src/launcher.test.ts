import { describe, it, expect } from 'vitest';
import { readJa3Records, waitForJa3Record } from './launcher.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('readJa3Records', () => {
  it('returns empty array for missing file', () => {
    expect(readJa3Records('/nonexistent/path.jsonl')).toEqual([]);
  });
  it('correlates a ClientHello record to one request id', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tah-ja3-'));
    const file = path.join(dir, 'ja3.jsonl');
    writeFileSync(file, JSON.stringify({ correlation_id: 'request-1', ja3_hash: 'abc', ja3_raw: '771,1,2,3,0' }) + '\n');
    expect((await waitForJa3Record(file, 'request-1', 50))?.ja3_hash).toBe('abc');
  });
});
