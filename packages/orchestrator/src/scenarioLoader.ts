import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'yaml';
// Task 8 left these as default imports; TS 5.x + NodeNext treats the default
// import as the module namespace here, so `new Ajv(...)` fails with
// TS2351. Use named imports which match the package's actual exports.
// `ajv-formats` ships a default-export function but with the same TS interop
// quirk; load it through a CJS namespace import and pull `.default` off.
import { Ajv } from 'ajv';
import * as ajvFormats from 'ajv-formats';
const addFormats = (ajvFormats as unknown as { default: (ajv: Ajv) => void }).default;
import type { Scenario } from '@tah/contracts';

// Brief specified `../../scenarios/schema.json` but __dirname resolves to
// packages/orchestrator/src under vitest, so that path lands at packages/scenarios/
// (nonexistent). The actual workspace schema lives at scenarios/schema.json at the
// repo root, requiring one extra `../`. Same correction needed when running from dist/.
const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(here, '../../../scenarios/schema.json');

// scenarios/schema.json declares $schema: https://json-schema.org/draft-07/schema#,
// but Ajv 8 only ships the http:// variant pre-registered. Register the meta-schema
// under the https:// key so Ajv resolves the $schema reference.
const DRAFT07_HTTPS = 'https://json-schema.org/draft-07/schema#';

export async function loadScenario(filePath: string): Promise<Scenario> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = yaml.parse(raw);
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  if (!ajv.getSchema(DRAFT07_HTTPS)) {
    // Resolve ajv's package install via Node's resolver (avoids hard-coding
    // a relative node_modules path that differs between vitest/src and dist/).
    const req = createRequire(here + '/');
    const ajvEntry = req.resolve('ajv');
    const metaPath = path.join(path.dirname(ajvEntry), 'refs/json-schema-draft-07.json');
    const metaRaw = await readFile(metaPath, 'utf8');
    const metaSchema = JSON.parse(metaRaw);
    // Rewrite the meta-schema's $id to the https:// key the scenario schema
    // references, so Ajv can resolve it without colliding with the pre-registered
    // http:// variant.
    metaSchema.$id = DRAFT07_HTTPS;
    ajv.addMetaSchema(metaSchema);
  }
  const schemaRaw = await readFile(SCHEMA_PATH, 'utf8');
  const validate = ajv.compile(JSON.parse(schemaRaw));
  if (!validate(parsed)) {
    throw new Error('scenario schema violation: ' + JSON.stringify(validate.errors, null, 2));
  }
  return parsed as Scenario;
}