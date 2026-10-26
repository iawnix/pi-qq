import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.js";
import { config } from "./helpers.js";

test("SQLite memories survive reopen and remain scoped across users, groups and apps", () => {
  const cfg = config();
  const root = join(cfg.dataDir, "memory");
  const first = new MemoryStore(root, cfg.memory);
  const a = first.add("app/c2c/alice", "喜欢简洁回答", "a");
  first.add("app/c2c/alice", "正在开发 QQ 插件", "b");
  first.add("app/group/g/alice", "群内偏好", "c");
  first.add("app2/c2c/alice", "另一个机器人", "d");
  assert.equal(first.list("app/c2c/alice").length, 2);
  assert.equal(first.remove("app/group/g/alice", a.id), false);
  first.close();
  const next = new MemoryStore(root, cfg.memory);
  assert.equal(next.list("app/c2c/alice").length, 2);
  assert.ok(next.context("app/c2c/alice", "QQ 插件").every(m => m.scope === "app/c2c/alice"));
  assert.equal(next.context("unknown", "").length, 0);
  next.close();
});

test("limits do not evict other scopes; profiles update in place; injection is bounded", () => {
  const cfg = config();
  cfg.memory.maxPerScope = 2;
  cfg.memory.maxInjectedChars = 5;
  const store = new MemoryStore(cfg.dataDir, cfg.memory);
  const p = store.add("a", "简短", "m1", { name: "replyStyle" });
  store.add("a", "TypeScript", "m2");
  store.add("b", "other", "m3");
  assert.throws(() => store.add("a", "third", "m4"), /上限/);
  assert.equal(store.add("a", "详细", "m5", { name: "replyStyle" }).id, p.id);
  assert.equal(store.list("a").length, 2);
  assert.equal(store.list("b").length, 1);
  assert.deepEqual(store.context("a", "TypeScript").map(m => m.text), ["详细"]);
  store.setEnabled("a", false);
  assert.deepEqual(store.context("a", ""), []);
  assert.throws(() => store.add("a", "new", "m6"), /关闭/);
  store.close();
});

test("automatic candidates need confirmation and expire; explicit memories honor retention", () => {
  const cfg = config();
  cfg.memory.retentionDays = 1;
  let now = 1000;
  const store = new MemoryStore(cfg.dataDir, cfg.memory, () => now);
  const pending = store.add("a", "候选", "source-message", { pending: true });
  assert.equal(store.context("a", "").length, 0);
  assert.equal(store.accept("b", pending.id), false);
  assert.equal(store.accept("a", pending.id), true);
  assert.equal(store.context("a", "")[0]!.source, "source-message");
  now += 86400001;
  assert.equal(store.hasExpired("a"), true);
  assert.equal(store.context("a", "").length, 0);
  store.expire("a");
  assert.equal(store.find("a", pending.id), undefined);
  const later = store.add("a", "expire candidate", "s", { pending: true });
  now += 8 * 86400000;
  assert.equal(store.accept("a", later.id), false);
  assert.deepEqual(store.list("a", "pending"), []);
  store.close();
});

test("group mode changes advance persisted epochs and keep memory namespaces separate", () => {
  const cfg = config();
  const store = new MemoryStore(cfg.dataDir, cfg.memory);
  assert.equal(store.route("g", "group"), 0);
  assert.equal(store.route("g", "member"), 1);
  assert.equal(store.route("g", "group"), 2);
  store.registerConversation("scope", "old");
  store.registerConversation("scope", "new");
  store.registerConversation("scope", "new");
  store.close();
  const reopened = new MemoryStore(cfg.dataDir, cfg.memory);
  assert.equal(reopened.route("g", "group"), 2);
  assert.deepEqual(new Set(reopened.conversationKeys("scope")), new Set(["old", "new"]));
  reopened.resetRoute("g");
  assert.equal(reopened.route("g", "group"), 3);
  reopened.close();
});
