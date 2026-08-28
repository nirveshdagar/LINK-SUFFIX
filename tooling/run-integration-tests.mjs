import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

if (existsSync(".env")) loadEnvFile(".env");

const testsDirectory = fileURLToPath(new URL("../web/tests/", import.meta.url));
const testFiles = readdirSync(testsDirectory)
  .filter(name => name.endsWith(".integration.test.ts"))
  .sort()
  .map(name => fileURLToPath(new URL(`../web/tests/${name}`, import.meta.url)));

if (testFiles.length === 0) throw new Error("No integration tests were found");

const child = spawn(process.execPath, ["--test", ...testFiles], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", error => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Integration test runner exited from signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
