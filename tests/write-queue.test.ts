import assert from "node:assert/strict";
import { WriteQueue } from "../src/state/write-queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function run(): Promise<void> {
  const queue = new WriteQueue();
  const gate = deferred();
  const entered = deferred();
  const order: string[] = [];

  const first = queue.run("session", async () => {
    order.push("first-start");
    entered.resolve();
    await gate.promise;
    order.push("first-end");
  });
  const second = queue.run("session", async () => { order.push("second"); });
  await entered.promise;
  assert.deepEqual(order, ["first-start"]);
  assert.equal(queue.hasPending("session"), true);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  assert.equal(queue.hasPending("session"), false);

  let fail = true;
  let latest = "old";
  let saved = "";
  const writeLatest = async (): Promise<void> => {
    if (fail) throw new Error("disk full");
    saved = latest;
  };
  await assert.rejects(queue.run("retry", writeLatest), /disk full/);
  assert.equal(queue.hasPending("retry"), true);
  latest = "new";
  fail = false;
  await queue.retry("retry");
  assert.equal(saved, "new");
  assert.equal(queue.hasPending("retry"), false);
}

void run().then(() => console.log("write queue harness passed"));
