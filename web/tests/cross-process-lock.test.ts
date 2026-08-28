import assert from "node:assert/strict";
import test from "node:test";
import { withCrossProcessLock } from "../lib/cross-process-lock.ts";

test("shared mutations execute serially", async () => {
  const previousDatabase = process.env.DATABASE_URL;
  const previousDistributed = process.env.TAH_DISTRIBUTED_REQUIRED;
  delete process.env.DATABASE_URL;
  delete process.env.TAH_DISTRIBUTED_REQUIRED;
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => withCrossProcessLock("test-serial-lock", async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2 + (index % 3)));
      active -= 1;
    })));
    assert.equal(maximum, 1);
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
    if (previousDistributed === undefined) delete process.env.TAH_DISTRIBUTED_REQUIRED; else process.env.TAH_DISTRIBUTED_REQUIRED = previousDistributed;
  }
});
