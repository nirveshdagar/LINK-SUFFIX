import { describe, it, expect } from 'vitest';
import { loadScenario } from './scenarioLoader.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const goodYaml = `
id: t1
tier: trivial-http
seed_url: https://example.test/
geo: {country: US}
proxy_mode: rotating-residential
repeats: 5
expected_verdict: block
`;

describe('loadScenario', () => {
  it('accepts a minimal valid scenario', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tah-scn-'));
    try {
      const f = path.join(dir, 't1.yaml');
      writeFileSync(f, goodYaml);
      const s = await loadScenario(f);
      expect(s.id).toBe('t1');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});