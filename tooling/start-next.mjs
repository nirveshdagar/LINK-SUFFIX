import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environmentFile = path.join(root, ".env");
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
process.chdir(root);
await import("next/dist/bin/next");
