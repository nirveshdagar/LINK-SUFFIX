import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { acquireBrowserPermit } from './browserPermit.js';

describe('cross-process browser permits', () => {
  it('holds excess browser work until a permit is released', async () => {
    const permitDir = mkdtempSync(path.join(tmpdir(), 'tah-browser-permits-'));
    try {
      const first = await acquireBrowserPermit({ permitDir, maxPermits: 2, timeoutMs: 1_000, pollMs: 10 });
      const second = await acquireBrowserPermit({ permitDir, maxPermits: 2, timeoutMs: 1_000, pollMs: 10 });
      let thirdResolved = false;
      const thirdPromise = acquireBrowserPermit({ permitDir, maxPermits: 2, timeoutMs: 1_000, pollMs: 10 })
        .then((permit) => { thirdResolved = true; return permit; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(thirdResolved).toBe(false);
      first.release();
      const third = await thirdPromise;
      expect(thirdResolved).toBe(true);
      second.release();
      third.release();
    } finally {
      rmSync(permitDir, { recursive: true, force: true });
    }
  });
});
