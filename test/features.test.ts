import test from "node:test";
import assert from "node:assert/strict";
import { ChatBridge } from "../src/bridge.js";
import type { AgentRunner } from "../src/agent.js";
import type { ChatImage } from "../src/content.js";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { MediaInput } from "../src/media.js";
import { MemoryStore } from "../src/memory.js";
import { config, deferred, groupMessage, message, tick } from "./helpers.js";

function fixture(cfg = config(), media?: MediaInput, memory?: MemoryStore) {
  const calls: Array<{ key: string; prompt: string; images: ChatImage[] }> = [];
  const replies: string[] = [];
  const sent: Array<{ target: ReplyTarget; buffer: Buffer }> = [];
  const resets: string[] = [];
  const purges: string[] = [];
  const runner: AgentRunner = {
    run: async (key, prompt, _system, _signal, options) => { calls.push({ key, prompt, images: options?.images ?? [] }); return "answer"; },
    reset: async key => { resets.push(key); },
    purge: async key => { purges.push(key); },
  };
  const bridge = new ChatBridge(cfg, runner, {
    sendText: async (_target, text) => { replies.push(text); },
    sendImage: async (target, source) => {
      sent.push({ target, buffer: source.buffer! });
      return { upload: { file_uuid: "f", file_info: "i", ttl: 1, id: "u" }, message: { id: "sent", timestamp: Date.now() } };
    },
  }, () => {}, { media, memory });
  return { cfg, bridge, runner, calls, replies, resets, purges, sent };
}

const memoryId = (reply: string) => /（([a-f0-9]{12})）/.exec(reply)![1]!;

test("member mode isolates histories and memories, permits own reset, and retains whole-group rate cap", async () => {
  const cfg = config(); cfg.groups.g!.sessionScope = "member";
  const f = fixture(cfg);
  await f.bridge.handle(groupMessage({ content: "ALICE_HISTORY", rawEventType: "GROUP_MESSAGE_CREATE" }));
  await f.bridge.handle(groupMessage({ senderId: "bob", content: "BOB_HISTORY", rawEventType: "GROUP_MESSAGE_CREATE" }));
  await f.bridge.handle(groupMessage({ content: "/remember ALICE_MEMORY" }));
  await f.bridge.handle(groupMessage());
  await f.bridge.handle(groupMessage({ senderId: "bob" }));
  assert.notEqual(f.calls[0]!.key, f.calls[1]!.key);
  assert.ok(f.calls[0]!.prompt.includes("ALICE_HISTORY"));
  assert.ok(f.calls[0]!.prompt.includes("ALICE_MEMORY"));
  assert.ok(!f.calls[0]!.prompt.includes("BOB_HISTORY"));
  assert.ok(!f.calls[1]!.prompt.includes("ALICE_"));
  await f.bridge.handle(groupMessage({ content: "/reset" }));
  assert.deepEqual(f.resets, [f.calls[0]!.key]);
  cfg.rateLimit.perGroup = 2;
  await f.bridge.handle(groupMessage({ senderId: "admin" }));
  assert.equal(f.calls.length, 2);
  await f.bridge.stop();
});

test("shared-group memory is administrator-managed and private chat facts never enter group", async () => {
  const f = fixture();
  await f.bridge.handle(message({ content: "/remember PRIVATE_FACT" }));
  const privateId = memoryId(f.replies.at(-1)!);
  await f.bridge.handle(groupMessage({ content: "/remember should not save" }));
  assert.match(f.replies.at(-1)!, /管理员/);
  await f.bridge.handle(groupMessage({ senderId: "admin", content: "/remember PUBLIC_GROUP_FACT" }));
  await f.bridge.handle(groupMessage());
  assert.ok(f.calls[0]!.prompt.includes("PUBLIC_GROUP_FACT"));
  assert.ok(!f.calls[0]!.prompt.includes("PRIVATE_FACT"));
  await f.bridge.handle(groupMessage({ senderId: "admin", content: `/forget ${privateId}` }));
  assert.equal(f.purges.length, 0);
  await f.bridge.handle(message());
  assert.ok(f.calls[1]!.prompt.includes("PRIVATE_FACT"));
  await f.bridge.stop();
});

test("explicit facts and profiles survive service restart/reset; forget clears every conversation generation", async () => {
  const cfg = config();
  const first = fixture(cfg);
  await first.bridge.handle(message({ content: "/remember FACT" }));
  const id = memoryId(first.replies.at(-1)!);
  await first.bridge.handle(message({ content: "/profile replyStyle=简短" }));
  await first.bridge.handle(message({ content: "/reset" }));
  await first.bridge.stop();
  const next = fixture(cfg);
  await next.bridge.handle(message());
  assert.ok(next.calls[0]!.prompt.includes("FACT"));
  assert.ok(next.calls[0]!.prompt.includes("简短"));
  await next.bridge.handle(message({ content: `/forget ${id}` }));
  assert.equal(next.purges.length, 1);
  await next.bridge.handle(message());
  assert.ok(!next.calls[1]!.prompt.includes("FACT"));
  assert.ok(next.calls[1]!.prompt.includes("简短"));
  await next.bridge.handle(message({ content: "/memory off" }));
  await next.bridge.handle(message());
  assert.deepEqual(JSON.parse(next.calls[2]!.prompt).memories, []);
  await next.bridge.handle(message({ content: "/memory on" }));
  await next.bridge.handle(message());
  assert.ok(next.calls[3]!.prompt.includes("简短"));
  await next.bridge.stop();
});

test("mode switches create fresh sessions and admin reset-all waits for running members to abort", async () => {
  const cfg = config();
  const first = fixture(cfg);
  await first.bridge.handle(groupMessage());
  const original = first.calls[0]!.key;
  await first.bridge.stop();
  cfg.groups.g!.sessionScope = "member";
  const member = fixture(cfg);
  await member.bridge.handle(groupMessage());
  const memberKey = member.calls[0]!.key;
  const gate = deferred<string>();
  const signals: AbortSignal[] = [];
  member.runner.run = async (_key, _prompt, _system, signal) => { signals.push(signal); return gate.promise; };
  const a = member.bridge.handle(groupMessage());
  const b = member.bridge.handle(groupMessage({ senderId: "bob" }));
  await tick();
  let resetDone = false;
  const reset = member.bridge.handle(groupMessage({ senderId: "admin", content: "/reset all" })).then(() => { resetDone = true; });
  await tick();
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(resetDone, false);
  gate.resolve("cancelled answer");
  await Promise.all([a, b, reset]);
  assert.ok(!member.replies.includes("cancelled answer"));
  await member.bridge.stop();
  cfg.groups.g!.sessionScope = "group";
  const shared = fixture(cfg);
  await shared.bridge.handle(groupMessage());
  assert.notEqual(shared.calls[0]!.key, original);
  assert.notEqual(shared.calls[0]!.key, memberKey);
  await shared.bridge.stop();
});

test("automatic memories remain candidates until accepted; deletion waits for pending extraction", async () => {
  const cfg = config(); cfg.memory.autoExtract = true;
  const f = fixture(cfg);
  const gate = deferred<Array<{ text: string }>>();
  f.runner.suggestMemories = async () => gate.promise;
  const work = f.bridge.handle(message({ content: "我喜欢简短回答" }));
  await tick();
  gate.resolve([{ text: "偏好简短回答" }]);
  await work;
  f.runner.suggestMemories = undefined;
  await f.bridge.handle(message());
  assert.deepEqual(JSON.parse(f.calls[1]!.prompt).memories, []);
  await f.bridge.handle(message({ content: "/memory pending" }));
  const id = /([a-f0-9]{12}):/.exec(f.replies.at(-1)!)![1]!;
  await f.bridge.handle(message({ content: `/memory accept ${id}` }));
  await f.bridge.handle(message());
  assert.ok(f.calls[2]!.prompt.includes("偏好简短回答"));
  const secondGate = deferred<Array<{ text: string }>>();
  f.runner.suggestMemories = async () => secondGate.promise;
  const second = f.bridge.handle(message());
  await tick();
  const forget = f.bridge.handle(message({ content: "/forget all" }));
  assert.equal(f.purges.length, 0);
  secondGate.resolve([{ text: "another candidate" }]);
  await Promise.all([second, forget]);
  await f.bridge.handle(message({ content: "/memory pending" }));
  assert.match(f.replies.at(-1)!, /没有记忆/);
  assert.equal(f.purges.length, 1);
  await f.bridge.stop();
});

test("memory expiry clears persisted context before the next model request", async () => {
  const cfg = config(); cfg.memory.retentionDays = 1;
  let now = Date.now();
  const store = new MemoryStore(cfg.dataDir, cfg.memory, () => now);
  const f = fixture(cfg, undefined, store);
  await f.bridge.handle(message({ content: "/remember expiring fact" }));
  await f.bridge.handle(message());
  now += 86400001;
  await f.bridge.handle(message());
  assert.equal(f.purges.length, 1);
  assert.deepEqual(JSON.parse(f.calls[1]!.prompt).memories, []);
  await f.bridge.stop();
});

test("images are admitted before download, image-only questions reach Pi, echo/generation retain reply ID", async () => {
  const cfg = config(); cfg.images.enabled = true;
  const image: ChatImage = { type: "image", data: Buffer.from("normalized").toString("base64"), mimeType: "image/jpeg" };
  let downloads = 0;
  const media: MediaInput = { load: async () => { downloads++; return [image]; }, normalize: async () => image };
  const f = fixture(cfg, media);
  const attachments = [{ content_type: "image/png", url: "https://cdn.example/image" }];
  await f.bridge.handle(message({ content: "", attachments }));
  assert.deepEqual(f.calls[0]!.images, [image]);
  const echo = message({ content: "/image echo", attachments });
  await f.bridge.handle(echo);
  assert.equal(f.sent[0]!.target.msgId, echo.messageId);
  let requested = "";
  f.runner.generateImage = async prompt => { requested = prompt; return [image]; };
  const generate = message({ content: "/image 一只猫" });
  await f.bridge.handle(generate);
  assert.equal(requested, "一只猫");
  assert.equal(f.sent[1]!.target.msgId, generate.messageId);
  cfg.rateLimit.perUser = 3;
  await f.bridge.handle(message({ content: "", attachments }));
  assert.equal(downloads, 2);
  await f.bridge.stop();
});

test("cancelled queued image request never downloads, and partial upload is not acknowledged as a sent image", async () => {
  const cfg = config(); cfg.images.enabled = true;
  const gate = deferred<string>();
  let downloads = 0;
  const image: ChatImage = { type: "image", data: "YQ==", mimeType: "image/jpeg" };
  const media: MediaInput = { load: async () => { downloads++; return [image]; }, normalize: async () => image };
  const f = fixture(cfg, media);
  f.runner.run = async () => gate.promise;
  const work = f.bridge.handle(message());
  const queued = f.bridge.handle(message({ content: "", attachments: [{ content_type: "image/png", url: "https://cdn.example/a" }] }));
  await tick();
  await f.bridge.handle(message({ content: "/stop" }));
  gate.resolve("cancelled");
  await Promise.all([work, queued]);
  assert.equal(downloads, 0);
  await f.bridge.stop();
  let sent = 0;
  const replies: string[] = [];
  const broken = new ChatBridge(config(), { run: async () => "", reset: async () => {}, purge: async () => {}, generateImage: async () => [image] }, {
    sendText: async (_t, text) => { replies.push(text); },
    sendImage: async () => { sent++; return { upload: { file_uuid: "f", file_info: "i", ttl: 1, id: "u" }, message: undefined }; },
  }, () => {}, { media });
  // The disabled-image path must not invoke the output adapter at all.
  await broken.handle(message({ content: "/image cat" }));
  assert.equal(sent, 0);
  assert.match(replies[0]!, /未启用/);
  await broken.stop();
  const enabled = new ChatBridge(cfg, { run: async () => "", reset: async () => {}, purge: async () => {}, generateImage: async () => [image] }, {
    sendText: async (_t, text) => { replies.push(text); },
    sendImage: async () => { sent++; return { upload: { file_uuid: "f", file_info: "i", ttl: 1, id: "u" }, message: undefined }; },
  }, () => {}, { media });
  await enabled.handle(message({ content: "/image cat" }));
  assert.equal(sent, 1);
  assert.match(replies.at(-1)!, /处理失败/);
  await enabled.stop();
});
