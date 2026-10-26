import test from "node:test";
import assert from "node:assert/strict";
import type { ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { dispatchEvent } from "@tencent-connect/qqbot-nodejs/protocol";
import { GroupChannels, type GroupDecision } from "../src/group-channel.js";
import { ChatBridge } from "../src/bridge.js";
import type { AgentRunOptions, AgentRunner } from "../src/agent.js";
import { config, groupMessage, message, deferred, tick } from "./helpers.js";

test("installed QQ SDK dispatches both full group messages and @ messages with sender/bot identity", () => {
  for (const event of ["GROUP_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"]) {
    const result = dispatchEvent(event, { id: "m", content: "hello", timestamp: new Date().toISOString(), group_openid: "g",
      author: { member_openid: "a", bot: false } }, "app");
    assert.equal(result.action, "message");
    if (result.action !== "message") throw new Error("Missing message");
    assert.equal(result.msg.rawEventType, event);
    assert.equal(result.msg.groupOpenid, "g");
    assert.equal(result.msg.senderId, "a");
    assert.equal(result.msg.senderIsBot, false);
  }
});

test("smart decisions are bounded by check interval, single flight, reply cooldown and hourly quota", () => {
  const cfg = config();
  cfg.groups.g!.smartReply = { checkIntervalMs: 1000, cooldownMs: 60000, maxPerHour: 1 };
  let now = 100000;
  const groups = new GroupChannels(cfg, { sendText: async () => {} }, () => now);
  assert.equal(groups.reserveDecision("g"), true);
  assert.equal(groups.reserveDecision("g"), false);
  groups.finishDecision("g");
  assert.equal(groups.reserveDecision("g"), false);
  now += 1001;
  assert.equal(groups.reserveDecision("g"), true);
  assert.equal(groups.commitDecision("g"), true);
  groups.finishDecision("g");
  now += 60001;
  assert.equal(groups.reserveDecision("g"), false); // hourly cap, despite cooldown ending
  now += 3600000;
  assert.equal(groups.reserveDecision("g"), true);
  groups.finishDecision("g");
  now += 1001;
  groups.recordReply("g", "刚刚回答了 @ 消息");
  assert.equal(groups.reserveDecision("g"), false);
});

test("proactive sends omit msgId, enforce opt-in/allowlist/bounds/rate, suppress echoes and drain on shutdown", async () => {
  const cfg = config();
  cfg.rateLimit.perGroup = 1;
  const sent: Array<{ target: ReplyTarget; text: string }> = [];
  const channels = new GroupChannels(cfg, { sendText: async (target, text) => { sent.push({ target, text }); return { id: "out1" }; } });
  await assert.rejects(channels.send("other", "hi"), /未在配置/);
  await assert.rejects(channels.send("g", "hi"), /allowProactive/);
  cfg.groups.g!.allowProactive = true;
  await assert.rejects(channels.send("g", " "), /1–4000/);
  await assert.rejects(channels.send("g", "x".repeat(4001)), /1–4000/);
  await assert.rejects(channels.send("g", "aborted", AbortSignal.abort()));
  assert.equal(await channels.send("g", " hello "), "out1");
  assert.deepEqual(sent, [{ target: { scope: "group", targetId: "g" }, text: "hello" }]);
  assert.equal(channels.ownMessage("g", "out1"), true);
  assert.equal(channels.ownMessage("other", "out1"), false);
  await assert.rejects(channels.send("g", "too soon"), /频率/);
  await channels.stop();
  await assert.rejects(channels.send("g", "stopped"), /停止/);
  const gate = deferred<{ id: string }>(), started = deferred();
  const pending = new GroupChannels(cfg, { sendText: async () => { started.resolve(); return gate.promise; } });
  const sending = pending.send("g", "in flight");
  await started.promise;
  let stopped = false;
  const stopping = pending.stop().then(() => { stopped = true; });
  assert.equal(stopped, false);
  gate.resolve({ id: "receipt" });
  await sending;
  await stopping;
  assert.equal(stopped, true);
  const failed = new GroupChannels(cfg, { sendText: async () => { throw new Error("SECRET_HTTP_BODY"); } });
  await assert.rejects(failed.send("g", "test"), error => error instanceof Error && !error.message.includes("SECRET") && error.message.includes("未确认成功"));
  await failed.stop();
});

test("smart group participation observes all members, stays silent when irrelevant, and never turns background messages into commands/tools", async t => {
  const cfg = config();
  cfg.groups.g!.sessionScope = "member";
  cfg.groups.g!.replyMode = "smart";
  cfg.groups.g!.allowProactive = true;
  cfg.groups.g!.allowTools = true;
  cfg.groups.g!.smartReply = { checkIntervalMs: 1000, cooldownMs: 0, maxPerHour: 10 };
  cfg.localTools.enabled = true; cfg.localTools.cwd = cfg.dataDir;
  cfg.rateLimit.perUser = 100;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let interested = false;
  const decisions: GroupDecision[] = [], calls: Array<{ prompt: string; options?: AgentRunOptions }> = [];
  const replies: string[] = [];
  const runner: AgentRunner = {
    run: async (_key, prompt, _sys, _signal, options) => { calls.push({ prompt, options }); return "一起聊聊这本书吧"; },
    reset: async () => {}, purge: async () => {},
    shouldReply: async input => { decisions.push(input); return interested; },
  };
  const bridge = new ChatBridge(cfg, runner, { sendText: async (_target, text) => { replies.push(text); return { id: `out-${replies.length}` }; } });
  const plain = (text: string, senderId = "alice") => groupMessage({ content: text, senderId, rawEventType: "GROUP_MESSAGE_CREATE" });
  await bridge.handle(message({ content: "/remember PRIVATE_ONLY" }));
  replies.length = 0;
  await bridge.handle(plain("甲乙两个人在聊天"));
  assert.equal(decisions.length, 1); assert.equal(calls.length, 0); assert.equal(replies.length, 0);
  await bridge.handle(plain("还有一句话", "bob"));
  assert.equal(decisions.length, 1);
  now += 1001; interested = true;
  await bridge.handle(plain("大家喜欢什么书？", "bob"));
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /甲乙两个人在聊天|还有一句话/);
  assert.doesNotMatch(calls[0]!.prompt, /PRIVATE_ONLY/);
  assert.equal(calls[0]!.options!.allowLocalTools, false);
  assert.deepEqual(calls[0]!.options!.qqTools, []);
  assert.ok(decisions.every(d => !JSON.stringify(d).includes("PRIVATE_ONLY")));
  await bridge.handle(plain("/remember BACKGROUND_COMMAND"));
  assert.equal(calls.length, 1);
  await bridge.handle(groupMessage({ content: "@ 提问不受选择性接话冷却影响" }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.options!.allowLocalTools, true);
  assert.equal(calls[1]!.options!.qqTools!.length, 1);
  assert.equal(decisions.length, 2);
  await bridge.handle(groupMessage({ content: "/memory" }));
  assert.doesNotMatch(replies.at(-1)!, /BACKGROUND_COMMAND/);
  const count = calls.length;
  await bridge.handle(plain("bot echo", "app")); // explicitly flagged bot below
  await bridge.handle(groupMessage({ content: "echo", senderIsBot: true }));
  assert.equal(calls.length, count);
  assert.ok(bridge.listGroups()[0]!.received.ordinary >= 4);
  await bridge.stop();
});

test("smart decision errors remain silent, and a requested group tool send suppresses duplicate automatic reply", async () => {
  const cfg = config();
  cfg.groups.g!.replyMode = "smart"; cfg.groups.g!.allowProactive = true;
  const sent: Array<{ target: ReplyTarget; text: string }> = [], reports: string[] = [];
  const runner: AgentRunner = { reset: async () => {}, purge: async () => {},
    shouldReply: async () => { throw new Error("model unavailable"); },
    run: async (_key, _prompt, _system, signal, options) => {
      const tool = options!.qqTools![0]!;
      await tool.execute("call", { text: "主动消息" }, signal, undefined, {} as never);
      return "已发完";
    } };
  const bridge = new ChatBridge(cfg, runner, { sendText: async (target, text) => { sent.push({ target, text }); return { id: "receipt" }; } }, c => reports.push(c));
  await bridge.handle(groupMessage({ content: "群内普通闲聊", rawEventType: "GROUP_MESSAGE_CREATE" }));
  assert.equal(sent.length, 0); assert.deepEqual(reports, ["group_decision_failed"]);
  await bridge.handle(groupMessage({ content: "请在这个群里主动发一条消息" }));
  assert.deepEqual(sent, [{ target: { scope: "group", targetId: "g" }, text: "主动消息" }]);
  await bridge.handle(groupMessage({ content: "主动消息", messageId: "receipt" }));
  assert.equal(sent.length, 1);
  await bridge.stop();
});

test("queued turns cannot reintroduce public group buffer text after forget", async () => {
  const cfg = config();
  cfg.concurrency = 1; cfg.groups.g!.sessionScope = "member"; cfg.groups.g!.replyMode = "all";
  const gate = deferred<string>(), started = deferred();
  const prompts: string[] = [];
  const bridge = new ChatBridge(cfg, { reset: async () => {}, purge: async () => {},
    run: async (_key, prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) { started.resolve(); return gate.promise; }
      return "ok";
    } }, { sendText: async () => {} });
  const active = bridge.handle(groupMessage({ content: "PUBLIC_TEXT_TO_FORGET" }));
  await started.promise;
  const forget = bridge.handle(groupMessage({ content: "/forget all" }));
  await tick();
  const later = bridge.handle(groupMessage({ senderId: "bob", content: "继续聊别的吧" }));
  gate.resolve("ok");
  await Promise.all([active, forget, later]);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1]!, /PUBLIC_TEXT_TO_FORGET/);
  await bridge.stop();
});
