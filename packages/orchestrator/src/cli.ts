#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { EventBus } from './eventBus.js';
import { runScenario } from './runner.js';
import { startDashboard } from '@tah/dashboard';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('tah')
    .description('Traffic Armour test harness CLI')
    .requiredOption('--scenario <file>', 'path to a scenario YAML file')
    .option('--parallel', 'run repeats concurrently', false)
    .option('--dashboard-port <port>', 'dashboard port', '7474')
    .option('--no-dashboard', 'disable dashboard')
    .parse(process.argv);

  const opts = program.opts<{
    scenario: string;
    parallel?: boolean;
    dashboardPort: string;
    dashboard: boolean;
  }>();

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(`runs/${runId}`);

  const bus = new EventBus();
  if (opts.dashboard) {
    const url = await startDashboard({ port: Number(opts.dashboardPort), bus, runDir });
    console.log(`dashboard at ${url}`);
  }

  const creds = {
    user: process.env.IPROYAL_USER ?? '',
    pass: process.env.IPROYAL_PASS ?? '',
  };
  if (!creds.user || !creds.pass) {
    console.error('IPROYAL_USER and IPROYAL_PASS must be set in env');
    process.exit(1);
  }

  await runScenario({
    scenarioFile: opts.scenario,
    runDir,
    bus,
    creds,
    parallel: opts.parallel,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
