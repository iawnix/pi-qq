import test from "node:test";
import assert from "node:assert/strict";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { ChatBridge } from "../src/bridge.js";
import type { AgentRunner } from "../src/agent.js";
import { config, deferred, groupMessage, message, tick } from "./helpers.js";

function fixture(run?: AgentRunner["run"], cfg = config()) {
  const calls: Array<{ key: string; prompt: string }> = [];
  const resets: string[] = [];
  const replies: Array<{ target: ReplyTarget; text: string }> = [];
  const reports: string[] = [];
  const bridge = new ChatBridge(cfg, {
    run: async (...args) => { calls.push({ key: args[0], prompt: args[1] }); return run ? run(...args) : "answer"; },
    reset: async key => { resets.push(key); },
    purge: async () => {},
  }, { sendText: async (target, text) => { replies.push({ target, text }); } }, code => reports.push(code));
  return { bridge, calls, resets, replies, reports };
}

test("allowlists, bot echoes, stale events and malformed targets never reach model", async () => {
  const f = fixture();
  for (const msg of [
    message({ senderId: "stranger", replyTarget: { scope: "c2c", targetId: "stranger" } }),
    message({ senderIsBot: true }), message({ timestamp: "invalid" }),
    message({ timestamp: new Date(Date.now() - 300001).toISOString() }),
    message({ replyTarget: { scope: "c2c", targetId: "bob" } }),
    groupMessage({ replyTarget: { scope: "group", targetId: "toString" } }),
  ]) await f.bridge.handle(msg);
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 0);
  await f.bridge.stop();
});

test("dedup and chat isolation; reply always uses originating message id", async () => {
  const f = fixture();
  const msg = message({ replyTarget: { scope: "c2c", targetId: "alice" } });
  await Promise.all([f.bridge.handle(msg), f.bridge.handle(msg)]);
  await f.bridge.handle(message({ senderId: "bob", replyTarget: { scope: "c2c", targetId: "bob" } }));
  await f.bridge.handle(groupMessage());
  assert.equal(f.calls.length, 3);
  assert.equal(new Set(f.calls.map(c => c.key)).size, 3);
  assert.equal(f.replies[0]!.target.msgId, msg.messageId);
  await f.bridge.stop();
});

test("group mention gate buffers delivered history and preserves messages arriving during run", async () => {
  const gate = deferred<string>();
  const f = fixture(async () => gate.promise);
  await f.bridge.handle(groupMessage({ content: "before", rawEventType: "GROUP_MESSAGE_CREATE" }));
  assert.equal(f.calls.length, 0);
  const first = f.bridge.handle(groupMessage({ content: "question1" }));
  await tick();
  await f.bridge.handle(groupMessage({ content: "during", rawEventType: "GROUP_MESSAGE_CREATE" }));
  gate.resolve("ok");
  await first;
  await f.bridge.handle(groupMessage({ content: "question2" }));
  assert.deepEqual(JSON.parse(f.calls[0]!.prompt).history.map((h: { text: string }) => h.text), ["before"]);
  assert.deepEqual(JSON.parse(f.calls[1]!.prompt).history.map((h: { text: string }) => h.text), ["during"]);
  await f.bridge.stop();
});

test("group reset requires configured member identity", async () => {
  const f = fixture();
  await f.bridge.handle(groupMessage({ content: "/reset", senderId: "alice" }));
  assert.equal(f.resets.length, 0);
  await f.bridge.handle(groupMessage({ content: "/reset", senderId: "admin" }));
  assert.equal(f.resets.length, 1);
  assert.equal(f.calls.length, 0);
  await f.bridge.stop();
});

test("group command strips app mention even when platform omits mentions array", async () => {
  const f = fixture();
  await f.bridge.handle(groupMessage({ content: "<@!app> /help" }));
  assert.equal(f.calls.length, 0);
  assert.match(f.replies[0]!.text, /文本聊天/);
  await f.bridge.stop();
});

test("group users can stop only their own work; admin can stop current work", async () => {
  const gate = deferred<string>();
  let signal!: AbortSignal;
  const f = fixture(async (_k, _p, _s, s) => { signal = s; return gate.promise; });
  const work = f.bridge.handle(groupMessage({ senderId: "alice" }));
  await tick();
  await f.bridge.handle(groupMessage({ senderId: "bob", content: "/stop" }));
  assert.equal(signal.aborted, false);
  await f.bridge.handle(groupMessage({ senderId: "admin", content: "/stop" }));
  assert.equal(signal.aborted, true);
  gate.resolve("must not send");
  await work;
  assert.ok(f.replies.every(r => r.text !== "must not send"));
  await f.bridge.stop();
});

test("rate budget limits generation without blocking stop/help; errors stay generic", async () => {
  const cfg = config();
  cfg.rateLimit.perUser = 1;
  const f = fixture(async () => { throw new Error("SECRET_API_BODY"); }, cfg);
  await f.bridge.handle(message());
  await f.bridge.handle(message());
  await f.bridge.handle(message({ content: "/help" }));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.reports, ["request_failed", "rate_limited"]);
  assert.equal(f.replies.length, 2);
  assert.ok(!JSON.stringify(f.replies).includes("SECRET"));
  await f.bridge.stop();
});

test("timeout aborts the runner and replies only once after cleanup", async () => {
  const cfg = config();
  cfg.timeoutMs = 10;
  const f = fixture(async (_k, _p, _s, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), cfg);
  await f.bridge.handle(message());
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!.text, /超时/);
  await f.bridge.stop();
});
