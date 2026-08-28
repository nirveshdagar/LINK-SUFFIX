#!/usr/bin/env node
// Cross-platform `npm run lint` driver. Walks every package's tsconfig and
// runs `tsc --noEmit` against each. Keeping this in
// JS avoids the cross-platform shell-glob headache (`packages/*/*/*.json`
// expands differently in cmd.exe vs bash).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const entries = fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true });
const configs = [];
for (const e of entries) {
  if (!e.isDirectory()) continue;
  const sub = path.join(root, 'packages', e.name);
  // Two-level layout: packages/<pkg>/tsconfig.json
  const direct = path.join(sub, 'tsconfig.json');
  if (fs.existsSync(direct)) configs.push(direct);
  // Three-level layout: packages/<group>/<tier>/tsconfig.json
  if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
    for (const s of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const inner = path.join(sub, s.name, 'tsconfig.json');
      if (fs.existsSync(inner)) configs.push(inner);
    }
  }
}
if (!configs.length) {
  console.error('no package tsconfigs found');
  process.exit(1);
}
let bad = 0;
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
for (const c of configs) {
  console.log(`>> ${c}`);
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', c], { stdio: 'inherit' });
  if (r.error) {
    console.error(r.error.message);
    bad++;
  } else if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
