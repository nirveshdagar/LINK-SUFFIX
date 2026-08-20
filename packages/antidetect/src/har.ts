import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface HarExportMeta {
  runId: string;
  geo: string;
}

export function buildHar(scenariosPath: string, meta: HarExportMeta): unknown {
  const lines = readFileSync(scenariosPath, 'utf8').split('\n').filter(Boolean);
  const entries: unknown[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      for (const r of ev.events ?? []) {
        entries.push({
          request: {
            method: 'GET',
            url: r.url,
            httpVersion: 'HTTP/1.1',
            headers: [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: 0,
          },
          response: {
            status: r.status,
            statusText: String(r.status),
            httpVersion: 'HTTP/1.1',
            headers: [],
            cookies: [],
            content: { size: 0, mimeType: 'text/html' },
            redirectURL: '',
            headersSize: -1,
            bodySize: 0,
          },
          time: (r.time_ms ?? 0),
          timings: { send: 0, wait: 0, receive: 0 },
        });
      }
    } catch {}
  }
  return {
    log: {
      version: '1.2',
      creator: { name: 'tah-har-export', version: '0.1.0' },
      entries,
    },
  };
}

export function writeHarFile(scenariosPath: string, outPath: string, meta: HarExportMeta): void {
  const har = buildHar(scenariosPath, meta);
  writeFileSync(outPath, JSON.stringify(har, null, 2));
}
