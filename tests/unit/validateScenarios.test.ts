import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { loadScenario } from '../../packages/orchestrator/src/scenarioLoader.js';

describe('example scenarios validate against schema', () => {
  const dir = path.resolve('./scenarios');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.yaml') || f === 'schema.json') continue;
    it(f, async () => {
      const s = await loadScenario(path.join(dir, f));
      expect(s.id).toBeTruthy();
      expect(['trivial-http','headless','stealth','human']).toContain(s.tier);
    });
  }
});
