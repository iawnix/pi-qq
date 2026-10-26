import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema, type Config } from "../src/config.js";
import { ChatBridge } from "../src/bridge.js";
import type { AgentRunner } from "../src/agent.js";
import { config, message, groupMessage, deferred } from "./helpers.js";

const links = [{ privateUser: "alice", groupMembers: { g: "group-alice" } }];
const gm = (content: string, senderId = "group-alice") => groupMessage({ content, senderId });
async function setup() {
  const cfg = config();
  cfg.groups.g!.sessionScope = "member";
  cfg.rateLimit = { perUser: 100, perGroup: 100, global: 200, windowMs: 60000 };
  cfg.character = { id: "friend", mode: "companion", soulFile: join(cfg.dataDir, "SOUL.md"), rulesFile: join(cfg.dataDir, "SYSTEM.md"),
    evolution: true, reflectionIntervalMs: 0, dailyEventLimit: 10, shareGroupExperiences: true };
  await writeFile(cfg.character.soulFile, "安静的朋友");
  await writeFile(cfg.character.rulesFile, "慢慢建立关系");
  return cfg;
}
function fixture(cfg: Config) {
  const calls: Array<{ key: string; prompt: string; system: string; tools: boolean | undefined }> = [];
  const replies: string[] = [], purges: string[] = [], merges: string[] = [], reports: string[] = [];
  const runner: AgentRunner = {
    run: async (key, prompt, system, _signal, options) => { calls.push({ key, prompt, system, tools: options?.allowLocalTools }); return "回复"; },
    reset: async key => { purges.push(key); }, purge: async key => { purges.push(key); },
    mergeHistory: async (source, target) => { merges.push(JSON.stringify([source, target])); },
    reflect: async input => ({ experience: { summary: input.text, evidence: input.text, kind: "interaction", confidence: 1,
      trust: 1, comfort: 1, affinity: 1, public: true }, facts: [] }),
  };
  const bridge = new ChatBridge(cfg, runner, { sendText: async (_target, text) => { replies.push(text); } }, code => reports.push(code));
  return { bridge, runner, calls, replies, purges, merges, reports };
}

test("identity links require explicit unique transport identities and member-scoped configured groups", () => {
  const base = { appId: "app", groups: { g: { sessionScope: "member" } }, identityLinks: links };
  assert.equal(configSchema.safeParse(base).success, true);
  assert.equal(configSchema.safeParse({ ...base, groups: { g: {} } }).success, false);
  assert.equal(configSchema.safeParse({ ...base, groups: {} }).success, false);
  assert.equal(configSchema.safeParse({ ...base, identityLinks: [...links, ...links] }).success, false);
  assert.equal(configSchema.safeParse({ ...base, identityLinks: [...links, { privateUser: "bob", groupMembers: { g: "group-alice" } }] }).success, false);
});

test("binding merges memories and experiences, shares relationship in both directions, and preserves transport ACLs", async () => {
  const cfg = await setup();
  let f = fixture(cfg);
  await f.bridge.handle(message({ content: "/remember PRIVATE_FACT" }));
  await f.bridge.handle(gm("/remember GROUP_FACT"));
  await f.bridge.handle(message({ content: "/profile name=私人名字" }));
  await f.bridge.handle(gm("/profile name=群内名字"));
  await f.bridge.handle(message({ content: "/关系 下一阶段" }));
  await f.bridge.handle(message({ content: "PRIVATE_EVENT今天讨论了一本喜欢的书" }));
  await f.bridge.handle(gm("GROUP_EVENT今天一起谈到了河边的落日"));
  await f.bridge.stop();
  cfg.identityLinks = links;
  cfg.localTools.enabled = true;
  cfg.localTools.cwd = cfg.dataDir;
  cfg.localTools.allowUsers = ["alice"];
  f = fixture(cfg);
  await f.bridge.handle(gm("还记得之前的事情吗"));
  const group = f.calls.at(-1)!;
  assert.equal(f.merges.length, 1);
  assert.match(group.prompt, /PRIVATE_FACT/);
  assert.match(group.prompt, /GROUP_FACT/);
  assert.match(group.prompt, /PRIVATE_EVENT/);
  assert.match(group.prompt, /GROUP_EVENT/);
  assert.match(group.prompt, /私人名字/);
  assert.doesNotMatch(group.prompt, /群内名字/); // conflicting profile is pending
  assert.equal(group.tools, false); // private grant did not become a group grant
  await f.bridge.handle(gm("/memory pending"));
  assert.match(f.replies.at(-1)!, /群内名字/);
  await f.bridge.handle(gm("/关系"));
  assert.match(f.replies.at(-1)!, /朋友/);
  await f.bridge.handle(gm("/关系 下一阶段"));
  await f.bridge.handle(message({ content: "/关系" }));
  assert.match(f.replies.at(-1)!, /要好的朋友/);
  await f.bridge.handle(message({ content: "继续聊吧" }));
  assert.equal(f.calls.at(-1)!.key, group.key);
  assert.equal(f.calls.at(-1)!.tools, true);
  await f.bridge.handle(gm("别人也来聊聊", "bob"));
  assert.notEqual(f.calls.at(-1)!.key, group.key);
  assert.doesNotMatch(f.calls.at(-1)!.prompt, /PRIVATE_FACT|PRIVATE_EVENT/);
  await f.bridge.handle(gm("同样的字符串也不是自动绑定", "alice"));
  assert.notEqual(f.calls.at(-1)!.key, group.key);
  const count = f.calls.length;
  await f.bridge.handle(message({ senderId: "group-alice", replyTarget: { scope: "c2c", targetId: "group-alice" } }));
  assert.equal(f.calls.length, count);
  await f.bridge.handle(gm("/memory off"));
  await f.bridge.handle(message({ content: "不应再检索旧记忆" }));
  assert.doesNotMatch(f.calls.at(-1)!.prompt, /PRIVATE_FACT|PRIVATE_EVENT|GROUP_FACT/);
  await f.bridge.handle(message({ content: "/memory on" }));
  await f.bridge.handle(gm("/forget all"));
  assert.ok(f.purges.includes(group.key));
  assert.deepEqual(f.reports, []);
  await f.bridge.stop();
  f = fixture(cfg);
  await f.bridge.handle(message({ content: "删除以后重启测试" }));
  assert.equal(f.merges.length, 0);
  assert.doesNotMatch(f.calls.at(-1)!.prompt, /PRIVATE_FACT|PRIVATE_EVENT|GROUP_FACT|GROUP_EVENT/);
  await f.bridge.handle(message({ content: "/关系" }));
  assert.match(f.replies.at(-1)!, /要好的朋友/);
  await f.bridge.handle(gm("/重新认识 确认"));
  await f.bridge.handle(message({ content: "/关系" }));
  assert.match(f.replies.at(-1)!, /初识/);
  await f.bridge.stop();
});

test("linked sessions serialize both transports, can be stopped by the same person's other ID, and resist group-wide cancellation", async () => {
  const cfg = await setup();
  cfg.identityLinks = links;
  const f = fixture(cfg), started = deferred(), ended = deferred();
  f.runner.run = async (_key, _prompt, _system, signal) => {
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    ended.resolve();
    return "结束";
  };
  const running = f.bridge.handle(message());
  await started.promise;
  await f.bridge.handle(gm("/stop all", "admin"));
  assert.match(f.replies.at(-1)!, /没有可取消/);
  await f.bridge.handle(gm("/stop"));
  await ended.promise;
  await running;
  assert.match(f.replies.at(-1)!, /停止/);
  await f.bridge.stop();
});

test("failed migration can retry; removing a link stops sharing and reassignment fails closed", async () => {
  const cfg = await setup();
  let f = fixture(cfg);
  await f.bridge.handle(gm("/remember OLD_GROUP_FACT"));
  await f.bridge.stop();
  cfg.identityLinks = links;
  f = fixture(cfg);
  f.runner.mergeHistory = async () => { throw new Error("simulated interrupted migration"); };
  await assert.rejects(f.bridge.initialize(), /interrupted/);
  await f.bridge.stop();
  f = fixture(cfg);
  await f.bridge.handle(message({ content: "迁移失败后再试" }));
  assert.match(f.calls.at(-1)!.prompt, /OLD_GROUP_FACT/);
  await f.bridge.stop();
  cfg.identityLinks = [];
  f = fixture(cfg);
  await f.bridge.handle(gm("解除关联后的新消息"));
  assert.doesNotMatch(f.calls.at(-1)!.prompt, /OLD_GROUP_FACT/);
  await f.bridge.handle(gm("/remember UNLINKED_NEW_FACT"));
  await f.bridge.stop();
  cfg.identityLinks = links;
  f = fixture(cfg);
  await f.bridge.handle(message({ content: "重新绑定同一人" }));
  assert.match(f.calls.at(-1)!.prompt, /OLD_GROUP_FACT/);
  assert.match(f.calls.at(-1)!.prompt, /UNLINKED_NEW_FACT/);
  await f.bridge.stop();
  cfg.identityLinks = [{ privateUser: "bob", groupMembers: { g: "group-alice" } }];
  f = fixture(cfg);
  await assert.rejects(f.bridge.initialize(), /另一私聊身份/);
  await f.bridge.stop();
});
