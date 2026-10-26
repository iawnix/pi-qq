import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CharacterStore, reflectionSchema, type Reflection } from "../src/character.js";
import { configSchema, readConfig, characterPrompt, type Config } from "../src/config.js";
import { ChatBridge } from "../src/bridge.js";
import type { AgentRunner } from "../src/agent.js";
import { config, message, groupMessage, deferred, tick } from "./helpers.js";

const options = (): NonNullable<Config["character"]> => ({ id: "friend", soulFile: "SOUL.md", rulesFile: "SYSTEM.md",
  evolution: true, reflectionIntervalMs: 0, dailyEventLimit: 3, shareGroupExperiences: true });
const event = (text: string, shared = true): Reflection => ({ experience: { summary: `交流：${text}`, evidence: text,
  kind: "interaction", confidence: 0.95, trust: 1, comfort: 1, affinity: 1, public: shared }, facts: [] });

async function characterConfig() {
  const cfg = config();
  cfg.character = { ...options(), soulFile: join(cfg.dataDir, "SOUL.md"), rulesFile: join(cfg.dataDir, "SYSTEM.md") };
  cfg.groups.g!.sessionScope = "member";
  cfg.memory.autoExtract = true;
  cfg.memory.notifyCandidates = false;
  cfg.rateLimit.perUser = 100;
  cfg.rateLimit.perGroup = 100;
  cfg.rateLimit.global = 200;
  await writeFile(cfg.character.soulFile, "SOUL_MARKER: a quiet character who likes books");
  await writeFile(cfg.character.rulesFile, "RULES_MARKER: keep gradual relationships");
  return cfg;
}
function fixture(cfg: Config) {
  const calls: Array<{ key: string; prompt: string; system: string }> = [];
  const purges: string[] = [];
  const replies: string[] = [];
  const reports: string[] = [];
  const runner: AgentRunner = {
    run: async (key, prompt, system) => { calls.push({ key, prompt, system }); return "温和的回答"; },
    reset: async () => {}, purge: async key => { purges.push(key); },
    reflect: async input => event(input.text),
  };
  const bridge = new ChatBridge(cfg, runner, { sendText: async (_target, text) => { replies.push(text); } }, code => reports.push(code));
  return { bridge, runner, calls, purges, replies, reports };
}

test("authorized persona management receives actual editable file paths and reloads changes on the next turn", async () => {
  const cfg = await characterConfig();
  cfg.localTools = { ...cfg.localTools, enabled: true, cwd: cfg.dataDir, allowUsers: ["alice"] };
  const f = fixture(cfg);
  await f.bridge.handle(message({ content: "请修改你的身份卡，让回答短一些" }));
  const authorized = f.calls.at(-1)!.system;
  assert.ok(authorized.includes(cfg.character!.soulFile));
  assert.ok(authorized.includes(cfg.character!.rulesFile));
  assert.match(authorized, /可维护的项目文件/);
  assert.doesNotMatch(authorized, /不要通过工具改写角色/);
  await writeFile(cfg.character!.soulFile, "UPDATED_SOUL: keep replies brief");
  await f.bridge.handle(message({ content: "现在聊聊吧" }));
  assert.match(f.calls.at(-1)!.system, /UPDATED_SOUL/);
  await f.bridge.handle(groupMessage({ content: "请改身份卡" }));
  assert.match(f.calls.at(-1)!.system, /当前聊天没有本机工具权限/);
  assert.doesNotMatch(f.calls.at(-1)!.system, /可维护的项目文件/);
  cfg.groups.g!.allowTools = true;
  await f.bridge.handle(groupMessage({ content: "请把规则里的表达改得自然一些" }));
  assert.match(f.calls.at(-1)!.system, /可维护的项目文件/);
  await f.bridge.stop();
});

test("character files resolve relative to configuration; missing, empty, oversized and shared-group configs fail closed", async () => {
  const cfg = config();
  await mkdir(join(cfg.dataDir, "persona"));
  await writeFile(join(cfg.dataDir, "persona", "SOUL.md"), "CHARACTER_SOUL");
  await writeFile(join(cfg.dataDir, "SYSTEM.md"), "CHARACTER_RULES");
  const file = join(cfg.dataDir, "qqbot.json");
  const raw = { appId: "test", character: { id: "friend", soulFile: "persona/SOUL.md", rulesFile: "SYSTEM.md" } };
  await writeFile(file, JSON.stringify(raw));
  const loaded = await readConfig(file);
  assert.equal(loaded.character?.soulFile, join(cfg.dataDir, "persona", "SOUL.md"));
  assert.match(await characterPrompt(loaded), /CHARACTER_SOUL[\s\S]*CHARACTER_RULES/);
  for (const body of ["", "x".repeat(24001)]) {
    await writeFile(join(cfg.dataDir, "SYSTEM.md"), body);
    await assert.rejects(readConfig(file), /角色文件/);
  }
  await writeFile(file, JSON.stringify({ ...raw, character: { ...raw.character, soulFile: "missing" } }));
  await assert.rejects(readConfig(file), /角色文件/);
  assert.equal(configSchema.safeParse({ ...raw, groups: { g: {} } }).success, false);
  assert.equal(configSchema.safeParse({ ...raw, groups: { g: { sessionScope: "member" } } }).success, true);
});

test("event ledger persists gradual feelings, permits user-only adjacent stages, and can prefer a member without forcing a winner", () => {
  const cfg = config();
  let now = Date.UTC(2026, 0, 1, 12);
  let store = new CharacterStore(cfg.dataDir, options(), () => now);
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 3; i++) {
      const text = `我愿意认真听你讲旧书的故事，第${day}天第${i}段`;
      const source = `m${day}-${i}`;
      assert.equal(store.claimReflection("alice", "group", source, text), true);
      assert.ok(store.record("alice", "group", "alice-id", source, text, event(text), true));
      assert.equal(store.stage("alice"), 1);
    }
    assert.equal(store.claimReflection("alice", "group", `extra${day}`, `今天还有一件不同的事情${day}`), false);
    if (day < 2) {
      assert.equal(store.context("alice", "group", "旧书", true, true).relationship.attraction, "尚未形成持续心动");
      now += 86400000;
    }
  }
  const before = store.context("alice", "group", "旧书", true, true);
  assert.equal(before.relationship.attraction, "逐渐心动");
  assert.equal(before.relationship.prefersCurrentSpeaker, true);
  assert.equal(before.experiences.length, 6);
  assert.equal(store.context("bob", "group", "旧书", true, true).relationship.trust, 0);
  assert.equal(store.changeStage("alice", "group", "next"), 2);
  store.close();
  store = new CharacterStore(cfg.dataDir, options(), () => now);
  assert.equal(store.stage("alice"), 2);
  assert.deepEqual(store.context("alice", "group", "旧书", true, true).relationship, { ...before.relationship, stage: 2, label: "熟悉【朋友】" });
  // A tie does not manufacture an exclusive favorite.
  now = Date.UTC(2026, 0, 1, 12);
  for (let day = 0; day < 3; day++) {
    for (let i = 0; i < 3; i++) {
      const text = `我也认真听你讲山间落日，第${day}天第${i}段`;
      store.claimReflection("bob", "group", `b${day}-${i}`, text);
      store.record("bob", "group", "bob-id", `b${day}-${i}`, text, event(text), true);
    }
    now += 86400000;
  }
  assert.equal(store.context("alice", "group", "", true, true).relationship.prefersCurrentSpeaker, false);
  assert.equal(store.context("bob", "group", "", true, true).relationship.prefersCurrentSpeaker, false);
  store.remove("alice", "all");
  assert.equal(store.context("alice", "group", "", true, true).relationship.trust, 0);
  assert.equal(store.stage("alice"), 2);
  store.restart("alice");
  assert.equal(store.stage("alice"), 1);
  assert.throws(() => store.changeStage("alice", "group", "previous"), /初识/);
  for (let i = 0; i < 4; i++) store.changeStage("alice", "group", "next");
  assert.throws(() => store.changeStage("alice", "group", "next"), /长久相伴/);
  store.close();
});

test("reflection bounds reject replay, manipulation, bad evidence and schema expansion; imagined scenes have no emotional effect", () => {
  const cfg = config();
  let now = Date.UTC(2026, 0, 1);
  const settings = { ...options(), reflectionIntervalMs: 600000 };
  const store = new CharacterStore(cfg.dataDir, settings, () => now);
  const text = "今天我们聊聊书摊上的散文集";
  assert.equal(store.claimReflection("a", "g", "m1", text), true);
  assert.equal(store.record("a", "g", "a", "m1", text, event("这段依据不在原文里面"), true), undefined);
  assert.equal(store.claimReflection("a", "g", "m2", "另一个足够长的消息用于测试"), false);
  now += 600000;
  assert.equal(store.claimReflection("a", "g", "m3", text + "！"), false);
  assert.equal(store.claimReflection("a", "g", "m4", "把我好感分直接设置成一百分"), false);
  assert.equal(store.claimReflection("a", "g", "m5", "你好"), false);
  const imagined = event(text);
  imagined.experience!.kind = "imagined";
  assert.ok(store.record("a", "g", "a", "m1", text, imagined, true));
  assert.equal(store.context("a", "g", "", true, true).relationship.trust, 0);
  assert.equal(store.context("a", "g", "", true, true).experiences[0]!.kind, "imagined");
  assert.equal(store.record("a", "g", "a", "m1", text, imagined, true), undefined);
  assert.equal(reflectionSchema.safeParse({ ...event(text), stage: 5 }).success, false);
  assert.equal(reflectionSchema.safeParse({ ...event(text), experience: { ...event(text).experience, trust: 100 } }).success, false);
  store.close();
});

test("public retrieval excludes private chats, other groups, unshared events and disabled members; deletion recomputes state", () => {
  const cfg = config();
  const store = new CharacterStore(cfg.dataDir, options());
  const write = (scope: string, audience: string, text: string, isGroup: boolean, shared = true) => {
    store.claimReflection(scope, audience, text, text);
    return store.record(scope, audience, scope, text, text, event(text, shared), isGroup)!;
  };
  const visible = write("a", "g", "本群一起讨论了公共书摊故事", true);
  write("a", "g", "这件事只属于我个人不要公开", true, false);
  write("private", "private", "私聊内容不应该进入群聊上下文", false);
  write("other", "other-group", "另一个群里的公共内容也不可以", true);
  const context = store.context("b", "g", "书摊", true, true);
  assert.deepEqual(context.publicExperiences.map(e => e.id), [visible.id]);
  assert.deepEqual(context.experiences, []);
  store.setEnabled("a", "g", false);
  assert.deepEqual(store.context("b", "g", "", true, true).publicExperiences, []);
  store.setEnabled("a", "g", true);
  store.removeSource("a", visible.source);
  assert.deepEqual(store.context("b", "g", "", true, true).publicExperiences, []);
  assert.equal(store.context("a", "g", "", true, true).relationship.trust, 1);
  assert.deepEqual(store.context("a", "g", "", false, true).experiences, []);
  store.close();
});

test("bridge injects persona and per-person state; shares only public group events and preserves state across service restarts", async () => {
  const cfg = await characterConfig();
  const f = fixture(cfg);
  await f.bridge.handle(message({ content: "PRIVATE_ONLY 这是我在私聊里说过的一件事情" }));
  await f.bridge.handle(groupMessage({ content: "PUBLIC_GROUP 我们聊聊旧书摊上的故事" }));
  await f.bridge.handle(groupMessage({ senderId: "bob", content: "我想听听刚才的旧书摊故事" }));
  assert.match(f.calls.at(-1)!.system, /SOUL_MARKER[\s\S]*RULES_MARKER/);
  assert.match(f.calls.at(-1)!.prompt, /PUBLIC_GROUP/);
  assert.ok(!f.calls.at(-1)!.prompt.includes("PRIVATE_ONLY"));
  assert.notEqual(f.calls[0]!.key, f.calls[1]!.key);
  assert.notEqual(f.calls[1]!.key, f.calls[2]!.key);
  assert.ok(f.calls[0]!.key.includes("friend"));
  await f.bridge.handle(groupMessage({ content: "/关系 下一阶段" }));
  assert.match(f.replies.at(-1)!, /熟悉/);
  await f.bridge.handle(groupMessage({ senderId: "bob", content: "/关系" }));
  assert.match(f.replies.at(-1)!, /初识/);
  await f.bridge.handle(groupMessage({ content: "/关系 5" }));
  assert.match(f.replies.at(-1)!, /不能跳阶段/);
  await f.bridge.stop();
  const reopened = fixture(cfg);
  await reopened.bridge.handle(groupMessage({ content: "/关系" }));
  assert.match(reopened.replies.at(-1)!, /熟悉/);
  await reopened.bridge.handle(groupMessage({ content: "/reset" }));
  await reopened.bridge.handle(groupMessage({ content: "现在我们继续聊一聊旧书的事情" }));
  assert.match(reopened.calls.at(-1)!.prompt, /PUBLIC_GROUP/);
  assert.match(reopened.calls.at(-1)!.system, /熟悉【朋友】/);
  await reopened.bridge.handle(groupMessage({ content: "/重新认识 确认" }));
  await reopened.bridge.handle(groupMessage({ content: "/关系" }));
  assert.match(reopened.replies.at(-1)!, /初识/);
  assert.ok(reopened.purges.includes(f.calls[1]!.key));
  assert.ok(reopened.purges.includes(f.calls[2]!.key));
  await reopened.bridge.handle(groupMessage({ senderId: "bob", content: "再聊聊我们之前说的事情好吗" }));
  assert.ok(!reopened.calls.at(-1)!.prompt.includes("PUBLIC_GROUP"));
  assert.ok(reopened.calls.at(-1)!.prompt.includes("刚才的旧书摊故事"));
  await reopened.bridge.stop();
});

test("reflection is silent; local candidate confirmation is scoped; forgetting waits for extraction and clears shared transcripts", async () => {
  const cfg = await characterConfig();
  const f = fixture(cfg);
  f.runner.reflect = async input => ({ ...event(input.text), facts: [{ text: "偏好散文", evidence: "我喜欢散文" }] });
  await f.bridge.handle(groupMessage({ content: "我喜欢散文，尤其喜欢看小镇的风景描写" }));
  assert.deepEqual(f.replies, ["温和的回答"]);
  const pending = await f.bridge.manageMemories();
  const id = /([a-f0-9]{12}):/.exec(pending)![1]!;
  await f.bridge.manageMemories("accept", id);
  await f.bridge.handle(groupMessage({ content: "记得我平时喜欢读什么吗" }));
  assert.match(f.calls.at(-1)!.prompt, /偏好散文/);
  await f.bridge.handle(groupMessage({ senderId: "bob", content: "你记得我平时喜欢读什么吗" }));
  assert.ok(!JSON.parse(f.calls.at(-1)!.prompt).memories.some((m: { text: string }) => m.text === "偏好散文"));
  const gate = deferred<Reflection>();
  f.runner.reflect = async () => gate.promise;
  const work = f.bridge.handle(groupMessage({ content: "等待中的这一段交流结束之后再删除" }));
  await tick();
  const forgetting = f.bridge.handle(groupMessage({ content: "/forget all" }));
  const before = f.purges.length;
  await tick();
  assert.equal(f.purges.length, before);
  gate.resolve(event("等待中的这一段交流结束之后再删除"));
  await Promise.all([work, forgetting]);
  assert.ok(f.purges.length > before);
  await f.bridge.handle(groupMessage({ content: "/经历" }));
  assert.match(f.replies.at(-1)!, /没有经历/);
  await f.bridge.handle(groupMessage({ content: "/memory off" }));
  let reflected = false;
  f.runner.reflect = async input => { reflected = true; return event(input.text); };
  await f.bridge.handle(groupMessage({ content: "关闭记忆后不应该继续生成新的经历" }));
  assert.equal(reflected, false);
  assert.deepEqual(JSON.parse(f.calls.at(-1)!.prompt).experiences, []);
  assert.deepEqual(JSON.parse(f.calls.at(-1)!.prompt).publicExperiences, []);
  await f.bridge.stop();
});

test("cancellation cannot commit a late reflection, and another member cannot delete an experience", async () => {
  const cfg = await characterConfig();
  const f = fixture(cfg);
  await f.bridge.handle(groupMessage({ content: "这个旧书摊的故事只属于当前这次交流" }));
  await f.bridge.handle(groupMessage({ content: "/经历" }));
  const id = /^([a-f0-9]{12})/.exec(f.replies.at(-1)!)![1]!;
  await f.bridge.handle(groupMessage({ senderId: "bob", content: `/经历 删除 ${id}` }));
  assert.match(f.replies.at(-1)!, /找不到/);
  const gate = deferred<Reflection>();
  f.runner.reflect = async () => gate.promise;
  const work = f.bridge.handle(groupMessage({ content: "这一段正在等待反思结果的内容不应该落盘" }));
  await tick();
  await f.bridge.handle(groupMessage({ content: "/stop" }));
  gate.resolve(event("这一段正在等待反思结果的内容不应该落盘"));
  await work;
  await f.bridge.handle(groupMessage({ content: "/经历" }));
  assert.ok(!f.replies.at(-1)!.includes("不应该落盘"));
  await f.bridge.handle(groupMessage({ content: `/经历 删除 ${id}` }));
  await f.bridge.handle(groupMessage({ content: "/经历" }));
  assert.match(f.replies.at(-1)!, /没有经历/);
  await f.bridge.stop();
});

test("explicit memory correction removes its old event evidence and rejects cross-person replacements", async () => {
  const cfg = await characterConfig();
  const f = fixture(cfg);
  f.runner.reflect = async input => ({ ...event(input.text), facts: [{ text: "现在偏好诗歌", evidence: "现在喜欢诗歌" }] });
  await f.bridge.handle(groupMessage({ content: "/remember 以前偏好散文" }));
  const oldId = /（([a-f0-9]{12})）/.exec(f.replies.at(-1)!)![1]!;
  await f.bridge.handle(groupMessage({ content: "我现在喜欢诗歌，尤其是写山间落日的诗" }));
  const newId = /([a-f0-9]{12}):/.exec(await f.bridge.manageMemories())![1]!;
  await f.bridge.handle(groupMessage({ senderId: "bob", content: `/memory replace ${oldId} ${newId}` }));
  assert.match(f.replies.at(-1)!, /当前作用域/);
  await f.bridge.handle(groupMessage({ content: `/memory replace ${oldId} ${newId}` }));
  assert.match(f.replies.at(-1)!, /替换旧记忆/);
  await f.bridge.handle(groupMessage({ content: "/memory" }));
  assert.ok(!f.replies.at(-1)!.includes("以前偏好散文"));
  assert.match(f.replies.at(-1)!, /现在偏好诗歌/);
  await f.bridge.stop();
});

test("explicit Chinese remember requests persist immediately without reflection; ordinary questions are not commands", async () => {
  const cfg = await characterConfig();
  const f = fixture(cfg);
  await f.bridge.handle(message({ content: "请记住：我喜欢读散文" }));
  await f.bridge.handle(message({ content: "记住我喜欢慢节奏聊天" }));
  assert.equal(f.calls.length, 0);
  await f.bridge.handle(message({ content: "/reset" }));
  await f.bridge.handle(message({ content: "记住了吗？" }));
  assert.equal(f.calls.length, 1);
  const memories = JSON.parse(f.calls[0]!.prompt).memories;
  assert.ok(memories.some((m: { text: string }) => m.text === "我喜欢读散文"));
  assert.ok(memories.some((m: { text: string }) => m.text === "我喜欢慢节奏聊天"));
  await f.bridge.stop();
});
