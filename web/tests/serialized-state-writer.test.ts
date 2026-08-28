import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedStateWriter } from "../server/serialized-state-writer.mjs";

test("serialized state writer preserves names, snapshots, and write order", async () => {
  const writes: Array<{ name: string; value: unknown }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let call = 0;
  const queueStateSave = createSerializedStateWriter(async (name: string, value: unknown) => {
    call += 1;
    if (call === 1) await firstGate;
    writes.push({ name, value });
  });

  const campaigns = [{ id: "campaign-000001", status: "queued" }];
  const first = queueStateSave("campaigns", campaigns);
  campaigns[0].status = "mutated-after-queue";
  const second = queueStateSave("settings", { activeLimit: 500 });
  releaseFirst?.();
  await Promise.all([first, second]);

  assert.deepEqual(writes, [
    { name: "campaigns", value: [{ id: "campaign-000001", status: "queued" }] },
    { name: "settings", value: { activeLimit: 500 } },
  ]);
});

test("a failed state write does not block the next queued write", async () => {
  const writes: string[] = [];
  const queueStateSave = createSerializedStateWriter(async (name: string) => {
    writes.push(name);
    if (name === "runs") throw new Error("temporary database failure");
  });

  await assert.rejects(queueStateSave("runs", []), /temporary database failure/);
  await queueStateSave("campaigns", []);
  assert.deepEqual(writes, ["runs", "campaigns"]);
});
