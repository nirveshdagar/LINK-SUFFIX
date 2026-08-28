#!/usr/bin/env node

const moduleUrl = new URL("../lib/capacity-planner.ts", import.meta.url);
const {
  capacityInputFromEnvironment,
  planCapacity,
  renderCapacityReport,
} = await import(moduleUrl.href);

const modeArgument = process.argv.find((argument) => argument.startsWith("--mode="));
const mode = modeArgument?.split("=", 2)[1] ?? "production";
const json = process.argv.includes("--json");

const plan = planCapacity(capacityInputFromEnvironment(process.env));
const modes = {
  queue: plan.managedQueueReady,
  latest: plan.fleet.stableForNewestValue,
  parallel: plan.browser.trueParallelReady,
  production: plan.productionReadyForLatestValue,
  "every-capture": plan.productionReadyForEveryCapture,
};

if (!(mode in modes)) {
  throw new RangeError(
    `Unknown mode ${mode}. Use queue, latest, parallel, production, or every-capture.`,
  );
}

if (json) {
  process.stdout.write(`${JSON.stringify({ mode, passed: modes[mode], plan }, null, 2)}\n`);
} else {
  process.stdout.write(`${renderCapacityReport(plan)}\n`);
  process.stdout.write(`\nSelected gate (${mode}): ${modes[mode] ? "PASS" : "FAIL"}\n`);
}

if (!modes[mode]) process.exitCode = 2;
