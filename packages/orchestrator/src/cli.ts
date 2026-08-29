#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { EventBus } from '@tah/contracts';
import { runScenario } from './runner.js';
import { startDashboard } from '@tah/dashboard';
import { startMitm } from '@tah/mitm';
import { buildProxyEndpoint } from '@tah/proxy';
import { writeHarFile } from '@tah/antidetect';
import { loadScenario } from './scenarioLoader.js';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('tah')
    .description('Traffic Armour test harness CLI')
    .requiredOption('--scenario <file>', 'path to a scenario YAML file')
    .option('--parallel', 'run repeats concurrently', false)
    .option('--dashboard-port <port>', 'dashboard port', '7474')
    .option('--no-dashboard', 'disable dashboard')
    .option('--no-mitm', 'disable mitmproxy JA3 capture')
    .option('--mitm-port <port>', 'mitmproxy listen port', '8188')
    .parse(process.argv);

  const opts = program.opts<{
    scenario: string;
    parallel?: boolean;
    dashboardPort: string;
    dashboard: boolean;
    mitm: boolean;
    mitmPort: string;
  }>();

  const runId = process.env.TAH_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(`runs/${runId}`);

  // Check credentials first so a missing-env failure does not also leave a
  // dashboard listener bound to the port. (Otherwise `startDashboard` would
  // return, then process.exit(1) would tear the process down while the
  // server is still listening on 7474 — confusing on retry.)
  const creds = {
    user: process.env.IPROYAL_USER ?? '',
    pass: process.env.IPROYAL_PASS ?? '',
  };
  if (!creds.user || !creds.pass) {
    console.error('IPROYAL_USER and IPROYAL_PASS must be set in env');
    process.exit(1);
  }
  const serviceScenario = await loadScenario(opts.scenario);
  process.env.TAH_TELEMETRY_DIR = path.join(runDir, 'telemetry');

  const bus = new EventBus();
  if (opts.dashboard) {
    const url = await startDashboard({ port: Number(opts.dashboardPort), bus, runDir });
    console.log(`dashboard at ${url}`);
  }

  // Start mitmproxy sidecar so every request flows through it (browser tiers
  // via Playwright proxy.server, trivial-http via undici dispatcher). mitmproxy
  // itself proxies upstream to IP Royal. JA3/JA4 are written to recorderPath
  // and merged into ta_signal at the end of the run.
  let mitmHandle: Awaited<ReturnType<typeof startMitm>> | undefined;
  if (opts.mitm && serviceScenario.tier !== 'trivial-http') {
    console.error('mitm capture is restricted to trivial-http so browser journeys retain one residential session per browser');
  } else if (opts.mitm) {
    try {
      // Upstream URL is the IP Royal gateway — mitm forwards all browser
      // and trivial-http traffic to it.
      const upstream = buildProxyEndpoint(serviceScenario.geo, serviceScenario.proxy_mode, creds, `mitm${Date.now().toString(36)}`).url.toString();
      mitmHandle = await startMitm({ upstreamUrl: upstream, listenPort: Number(opts.mitmPort) });
      console.log(`mitm at ${mitmHandle.listenUrl} (recorder: ${mitmHandle.recorderPath})`);
      // Browser tiers use this to trust mitmproxy's CA cert.
      process.env.TAH_MITM_CA_PATH = mitmHandle.caCertPath;
      process.env.TAH_JA3_RECORDER = mitmHandle.recorderPath;
    } catch (e) {
      console.error(`mitm start failed: ${(e as Error).message}`);
      console.error('continuing without mitm — JA3 will not be captured');
    }
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (!mitmHandle) return;
    await mitmHandle.shutdown();
    try { fs.copyFileSync(mitmHandle.recorderPath, path.join(runDir, 'tls-clienthello.jsonl')); }
    catch (e) { console.error(`JA3 archive failed: ${(e as Error).message}`); }
  };
  const terminate = () => { void cleanup().finally(() => process.exit(143)); };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    await runScenario({
      scenarioFile: opts.scenario,
      runDir,
      bus,
      creds,
      parallel: opts.parallel,
      mitmUrl: mitmHandle?.listenUrl,
      runId,
      telemetryDir: path.join(runDir, 'telemetry'),
      challengeDir: process.env.TAH_CHALLENGE_DIR,
      proxyGateway: {
        hostname: process.env.IPROYAL_HOSTNAME,
        port: process.env.IPROYAL_PORT ? Number(process.env.IPROYAL_PORT) : undefined,
      },
    });
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
    await cleanup();
  }

// Post-run: invoke verify_geo.py (writes mismatches.csv + geo_resolved.jsonl)
  // then check_pool_exhaustion.py (exits 2 if any city has 3+ consecutive
  // mismatches). These are best-effort: missing MAXMIND_DB_PATH or absent
  // python are non-fatal — we still emit summary.json below.
  const py = process.env.TAH_PYTHON ?? 'python';
  fs.mkdirSync(runDir, { recursive: true });
  if (process.env.MAXMIND_DB_PATH) {
    const v = spawnSync(py, [
      path.resolve('tooling/py/verify_geo.py'),
      runDir,
    ], { stdio: 'inherit' });
    if (v.status !== 0) {
      console.error(`verify_geo.py exited ${v.status}`);
    }
    // Write summary.json + run pool-exhaustion check.
    writeSummary(runDir);
    const pe = spawnSync(py, [
      path.resolve('tooling/py/check_pool_exhaustion.py'),
      runDir,
    ], { stdio: 'inherit' });
    if (pe.status === 2) {
      console.error('pool exhausted — exiting 2');
      process.exit(2);
    }
  } else {
    console.log('MAXMIND_DB_PATH unset; skipping verify_geo + pool check');
    writeSummary(runDir);
  }
  try { writeHarFile(path.join(runDir, 'scenarios.jsonl'), path.join(runDir, 'run.har'), { runId, geo: [serviceScenario.geo.country, serviceScenario.geo.state, serviceScenario.geo.city].filter(Boolean).join('/') }); }
  catch (e) { console.error(`HAR export failed: ${(e as Error).message}`); }
}

/**
 * Aggregate the events JSONL into a summary blob (spec §?? — task 15
 * extension). Counts tiers × verdicts and a rough latency distribution.
 * Best-effort — failures are logged but do not abort the run.
 */
function writeSummary(runDir: string): void {
  try {
    const eventsPath = path.join(runDir, 'scenarios.jsonl');
    if (!fs.existsSync(eventsPath)) return;
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    const byTierVerdict: Record<string, Record<string, number>> = {};
    const byGeo: Record<string, Record<string, number>> = {};
    const latencies: number[] = [];
    let errors = 0;
    let expectationFailures = 0;
    let total = 0;
    for (const line of lines) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.expectation_met === false) expectationFailures++;
      total++;
      const tier = String(e.tier ?? 'unknown');
      const verdict = String(e.final_verdict ?? 'unknown');
      byTierVerdict[tier] ??= { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 };
      byTierVerdict[tier][verdict] = (byTierVerdict[tier][verdict] ?? 0) + 1;
      if (verdict === 'error') errors++;
      const geo = e.geo_requested ?? {};
      const cityKey = `${geo.country ?? ''}-${geo.state ?? ''}-${geo.city ?? ''}`;
      byGeo[cityKey] ??= { allow: 0, block: 0, challenge: 0, unsure: 0, error: 0 };
      byGeo[cityKey][verdict] = (byGeo[cityKey][verdict] ?? 0) + 1;
      const events = e.events ?? [];
      if (events.length) latencies.push(events[events.length - 1].time_ms ?? 0);
    }
    latencies.sort((a, b) => a - b);
    const pct = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0;
    const summary = {
      run_id: path.basename(runDir),
      total_requests: total,
      by_tier_verdict: byTierVerdict,
      by_geo: byGeo,
      latency_ms: { p50: pct(50), p95: pct(95), p99: pct(99) },
      errors,
      expectation_failures: expectationFailures,
    };
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    if (expectationFailures > 0) process.exitCode = process.exitCode || 3;
  } catch (e) {
    console.error(`summary.json write failed: ${(e as Error).message}`);
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error(e);
  process.exit(99);
});
