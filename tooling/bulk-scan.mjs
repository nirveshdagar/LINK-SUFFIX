#!/usr/bin/env node
/**
 * Bulk URL scanner — run L1 trivial-http across many URLs through IPRoyal
 * residential proxies with rotating geo targets.
 *
 * Usage:
 *   node tooling/bulk-scan.mjs <urls-file> [--concurrency N] [--repeats N]
 *
 * Output (stdout): JSONL, one object per request
 */

import http from 'node:http';
import tls from 'node:tls';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { buildProxyEndpoint } from '../packages/proxy/dist/index.js';
import { resolveProxyEgress } from '../packages/tz/dist/index.js';
import { aggregateVerdict, defaultStrategies } from '../packages/verdict/dist/index.js';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const urlFileIdx = args.findIndex(a => !a.startsWith('--'));
const urlFile = urlFileIdx >= 0 ? args[urlFileIdx] : null;
const flags = args.slice(urlFileIdx + 1);
const getFlag = (name, fallback) => {
  const i = flags.indexOf('--' + name);
  return (i >= 0 && i + 1 < flags.length) ? Number(flags[i + 1]) : fallback;
};

const CONCURRENCY = getFlag('concurrency', 5);
const REPEATS = getFlag('repeats', 1);

if (!urlFile) {
  console.error('Usage: node tooling/bulk-scan.mjs <urls-file> [--concurrency N] [--repeats N]');
  process.exit(1);
}

const creds = { user: process.env.IPROYAL_USER ?? '', pass: process.env.IPROYAL_PASS ?? '' };
if (!creds.user || !creds.pass) {
  console.error('IPROYAL_USER and IPROYAL_PASS must be set in env');
  process.exit(1);
}

const GEO_TARGETS = [
  { country: 'US', state: 'CA', city: 'LosAngeles' },
  { country: 'US', state: 'NY', city: 'NewYork' },
  { country: 'GB', city: 'London' },
  { country: 'DE', city: 'Berlin' },
  { country: 'IN', state: 'MH', city: 'Mumbai' },
  { country: 'JP', city: 'Tokyo' },
  { country: 'BR', state: 'SP', city: 'SaoPaulo' },
  { country: 'AU', state: 'NSW', city: 'Sydney' },
];

const ENABLED = ['http_status', 'challenge_html', 'header_signals', 'cookies', 'timing'];
const STRATEGIES = defaultStrategies(['cloudflare', 'hcaptcha', 'datadome', 'perimeterx', 'akamai', 'kasada', 'shape', 'fingerprintjs', 'generic']);

const raw = readFileSync(urlFile, 'utf8');
const urls = raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
if (!urls.length) { console.error('No URLs found'); process.exit(1); }

console.error(`Scanning ${urls.length} URLs x ${REPEATS} repeat(s) = ${urls.length * REPEATS} requests`);
const resultsFile = urlFile.replace(/\.\w+$/, '') + '-results.jsonl';
writeFileSync(resultsFile, '', 'utf8');

async function fetchViaProxy(urlStr, geo) {
  const endpoint = buildProxyEndpoint(geo, 'rotating-residential', creds, randomUUID().slice(0, 8));
  const proxyUrl = endpoint.url;
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const targetHost = url.hostname;
  const targetPort = url.port ? Number(url.port) : (isHttps ? 443 : 80);

  const tunnel = await new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString('base64'),
      },
    });
    req.once('connect', (_res, socket) => resolve(socket));
    req.once('error', reject);
    req.end();
  });

  let fp = {};
  let sock = tunnel;
  if (isHttps) {
    const tlsSocket = await new Promise((resolve, reject) => {
      const ts = tls.connect({ socket: tunnel, servername: targetHost });
      ts.once('secureConnect', () => resolve(ts));
      ts.once('error', reject);
    });
    sock = tlsSocket;
    const cert = sock.getPeerCertificate();
    fp = {
      tls_version: sock.getProtocol(),
      cipher: sock.getCipher()?.name,
      alpn: sock.alpnProtocol,
      server_cert_subject: cert?.subject?.CN,
      server_cert_issuer: cert?.issuer?.CN,
    };
  }

  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      host: targetHost,
      port: targetPort,
      method: 'GET',
      path: url.pathname + url.search,
      headers: { Connection: 'close', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html,*/*;q=0.8' },
      createConnection: () => sock,
    });
    const chunks = [];
    req.on('response', (res) => {
      const hdrs = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) hdrs[k] = v.join(', ');
        else if (v != null) hdrs[k] = String(v);
      }
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: hdrs, body: Buffer.concat(chunks).toString('utf8', 0, 65536) }));
    });
    req.on('error', reject);
    req.end();
  });

  sock.destroy();
  const latency = Date.now() - start;
  return { ...result, latency, fp };
}

async function scanOne(urlStr, geo) {
  let resolved = {};
  try {
    const endpoint = buildProxyEndpoint(geo, 'rotating-residential', creds, randomUUID().slice(0, 8));
    resolved = await resolveProxyEgress(endpoint.url);
  } catch { /* non-critical */ }

  let result;
  try {
    result = await fetchViaProxy(urlStr, geo);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // retry once on transient error, then try next geo in rotation
    try {
      await setTimeout(500);
      result = await fetchViaProxy(urlStr, geo);
    } catch (e2) {
      const nextGeo = GEO_TARGETS[(GEO_TARGETS.indexOf(geo) + 1) % GEO_TARGETS.length];
      try {
        await setTimeout(500);
        result = await fetchViaProxy(urlStr, nextGeo);
      } catch (e3) {
        const m3 = e3 instanceof Error ? e3.message : String(e3);
        return { url: urlStr, status: 0, verdict: 'error', vendors: [], geo_requested: geo, proxy_ip: null, latency_ms: 0, error: m3 };
      }
    }
  }

  const setCookies = Object.entries(result.headers).filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
  const input = {
    url: urlStr,
    status: result.status,
    responseHeaders: result.headers,
    responseBodySnippet: result.body,
    setCookies,
  };
  const verdict = aggregateVerdict(input, ENABLED, STRATEGIES);
  const vendors = Object.entries(verdict.byStrategy).filter(([, v]) => v === 'challenge' || v === 'block').map(([k]) => k);

  return {
    url: urlStr,
    status: result.status,
    verdict: verdict.final,
    vendors,
    geo_requested: geo,
    proxy_ip: resolved.ip || null,
    latency_ms: result.latency,
    tls: result.fp,
    has_challenge_page: /captcha|challenge|Press & Hold/i.test(result.body),
  };
}

import { setTimeout } from 'node:timers/promises';
const counts = {};
let errorCount = 0;

async function run() {
  for (let r = 0; r < REPEATS; r++) {
    const geo = GEO_TARGETS[r % GEO_TARGETS.length];
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const chunk = urls.slice(i, i + CONCURRENCY);
      const items = await Promise.allSettled(chunk.map(u => scanOne(u, geo)));
      const lines = [];
      for (const item of items) {
        const row = item.status === 'fulfilled' ? item.value : { url: 'unknown', status: 0, verdict: 'error', geo_requested: geo, error: String(item.reason) };
        counts[row.verdict] = (counts[row.verdict] || 0) + 1;
        if (row.verdict === 'error') errorCount++;
        process.stdout.write(JSON.stringify(row) + '\n');
        lines.push(JSON.stringify(row));
      }
      appendFileSync(resultsFile, lines.join('\n') + '\n');
      if (i + CONCURRENCY < urls.length) await setTimeout(500);
    }
  }

  console.error(`\n=== Summary: ${urls.length * REPEATS} requests ===`);
  for (const [v, c] of Object.entries(counts)) console.error(`  ${v}: ${c}`);
  console.error(`Results saved to: ${resultsFile}`);
  if (errorCount > 0) process.exitCode = 1;
}

run().catch(e => { console.error('Fatal:', e); process.exit(99); });
