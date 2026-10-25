import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler, QueueFullError, StoppedError } from "../src/scheduler.js";
import { deferred, tick } from "./helpers.js";

test("same chat serializes while different chats run in parallel", async () => {
  const scheduler = new Scheduler(2);
  const gate = deferred();
  const started: string[] = [];
  const first = scheduler.submit("a", "u", async () => { started.push("a1"); await gate.promise; });
  const second = scheduler.submit("a", "u", async () => { started.push("a2"); });
  const other = scheduler.submit("b", "u", async () => { started.push("b"); });
  await other;
  assert.deepEqual(started, ["a1", "b"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["a1", "b", "a2"]);
  await scheduler.stop();
});

test("abort retains ownership until runner settles; cancellation respects owner", async () => {
  const scheduler = new Scheduler();
  const gate = deferred();
  let signal!: AbortSignal;
  let nextStarted = false;
  const first = scheduler.submit("g", "alice", async s => { signal = s; await gate.promise; });
  const second = scheduler.submit("g", "bob", async () => { nextStarted = true; });
  await tick();
  assert.equal(scheduler.cancel("g", "other"), false);
  scheduler.cancel("g", "alice");
  assert.equal(signal.aborted, true);
  await tick();
  assert.equal(nextStarted, false);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(nextStarted, true);
  await scheduler.stop();
});

test("queue bounds and shutdown reject pending work and wait for active cleanup", async () => {
  const scheduler = new Scheduler(1, 1, 1);
  const gate = deferred();
  let signal!: AbortSignal;
  const active = scheduler.submit("a", "u", async s => { signal = s; await gate.promise; });
  const pending = scheduler.submit("a", "u", async () => assert.fail("pending ran"));
  const rejected = assert.rejects(pending, StoppedError);
  await assert.rejects(scheduler.submit("b", "u", async () => {}), QueueFullError);
  let stopped = false;
  const drain = scheduler.stop().then(() => { stopped = true; });
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(stopped, false);
  gate.resolve();
  await Promise.all([active, rejected, drain]);
  await assert.rejects(scheduler.submit("a", "u", async () => {}), StoppedError);
});
