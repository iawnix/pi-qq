import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConversationStore } from "../src/session-store.js";
import { chatCompactionSettings, chatTokenEstimate } from "../src/context.js";
import { configSchema } from "../src/config.js";
import { config } from "./helpers.js";

test("chat budget triggers below large model windows and fits small ones", () => {
  const cfg = config();
  assert.deepEqual(chatCompactionSettings(cfg.context, 128000), { enabled: true, reserveTokens: 104000, keepRecentTokens: 6000 });
  assert.deepEqual(chatCompactionSettings(cfg.context, 8192), { enabled: true, reserveTokens: 2048, keepRecentTokens: 3072 });
  assert.ok(chatTokenEstimate("这是中文消息") > chatTokenEstimate("abcdef"));
  assert.equal(configSchema.safeParse({ appId: "a", context: { maxTokens: 4096, keepRecentTokens: 4000 } }).success, false);
});

test("compacted context survives rollover while raw history is archived per identity and purge includes archives", async () => {
  const cfg = config();
  let now = Date.now();
  const store = new ConversationStore(cfg.dataDir, cfg.context, () => now);
  const alice = await store.open("alice");
  const bob = await store.open("bob");
  SessionManager.continueRecent(bob.cwd, bob.sessions).appendMessage({ role: "user", content: "BOB_PRIVATE", timestamp: now });
  const manager = SessionManager.continueRecent(alice.cwd, alice.sessions);
  manager.appendMessage({ role: "user", content: "ALICE_OLD_RAW", timestamp: now });
  const recent = manager.appendMessage({ role: "user", content: "ALICE_RECENT", timestamp: now });
  manager.appendCompaction("ALICE_SUMMARY", recent, 12000);
  await store.maintain("alice", manager);
  const next = await store.open("alice");
  assert.notEqual(next.sessions, alice.sessions);
  const restored = SessionManager.continueRecent(next.cwd, next.sessions);
  const context = JSON.stringify(restored.buildSessionContext().messages);
  assert.match(context, /ALICE_SUMMARY/);
  assert.match(context, /ALICE_RECENT/);
  assert.doesNotMatch(context, /ALICE_OLD_RAW|BOB_PRIVATE/);
  const archives = join(alice.sessions, "..", "archives");
  const archived = join(archives, "initial");
  const gz = (await readdir(archived)).find(name => name.endsWith(".gz"))!;
  assert.match(gunzipSync(await readFile(join(archived, gz))).toString(), /ALICE_OLD_RAW/);
  assert.equal((await stat(join(archived, gz))).mode & 0o777, 0o600);
  assert.equal((await stat(restored.getSessionFile()!)).mode & 0o777, 0o600);
  // A checkpoint must not recursively rotate on the old compaction again.
  await store.maintain("alice", restored);
  assert.deepEqual(await store.open("alice"), next);
  now += 100 * 86400000;
  await store.archiveInactive("alice");
  assert.equal((await readdir(archives)).length, 1); // retention=0 retains raw archives
  const expiring = new ConversationStore(cfg.dataDir, { ...cfg.context, archiveRetentionDays: 90 }, () => now);
  await expiring.archiveInactive("alice");
  assert.deepEqual(await readdir(archives), []);
  await store.reset("alice");
  assert.equal((await readdir(archives)).length, 1);
  assert.deepEqual(SessionManager.continueRecent((await store.open("alice")).cwd, (await store.open("alice")).sessions).buildSessionContext().messages, []);
  await store.purge("alice");
  await assert.rejects(stat(archives), { code: "ENOENT" });
  assert.match(JSON.stringify(SessionManager.continueRecent(bob.cwd, bob.sessions).buildSessionContext()), /BOB_PRIVATE/);
});

test("age and size rollover preserve an uncompacted conversation without mixing identities", async () => {
  const cfg = config();
  let now = Date.now();
  const store = new ConversationStore(cfg.dataDir, cfg.context, () => now);
  const first = await store.open("chat");
  const manager = SessionManager.continueRecent(first.cwd, first.sessions);
  manager.appendMessage({ role: "user", content: "KEEP_MY_REQUEST", timestamp: now });
  now += 8 * 86400000;
  await store.maintain("chat", manager);
  const second = await store.open("chat");
  assert.notEqual(first.sessions, second.sessions);
  const small = new ConversationStore(cfg.dataDir, { ...cfg.context, archiveAfterBytes: 1 });
  await small.maintain("chat", SessionManager.continueRecent(second.cwd, second.sessions));
  const third = await store.open("chat");
  assert.notEqual(second.sessions, third.sessions);
  assert.match(JSON.stringify(SessionManager.continueRecent(third.cwd, third.sessions).buildSessionContext()), /KEEP_MY_REQUEST/);
});


test("archive failure leaves the source intact and the committed checkpoint usable, then retries safely", async () => {
  const cfg = config();
  const store = new ConversationStore(cfg.dataDir, { ...cfg.context, archiveAfterBytes: 1 });
  const first = await store.open("alice");
  const manager = SessionManager.continueRecent(first.cwd, first.sessions);
  manager.appendMessage({ role: "user", content: "MUST_SURVIVE_ARCHIVE_FAILURE", timestamp: Date.now() });
  const archives = join(first.sessions, "..", "archives");
  await mkdir(archives);
  await writeFile(join(archives, "initial"), "blocking-file");
  await assert.rejects(store.maintain("alice", manager));
  assert.match(await readFile(manager.getSessionFile()!, "utf8"), /MUST_SURVIVE/);
  const active = await store.open("alice");
  assert.notEqual(first.sessions, active.sessions);
  assert.match(JSON.stringify(SessionManager.continueRecent(active.cwd, active.sessions).buildSessionContext()), /MUST_SURVIVE/);
  await rm(join(archives, "initial"));
  await store.archiveInactive("alice");
  await assert.rejects(stat(first.sessions), { code: "ENOENT" });
  assert.ok((await readdir(join(archives, "initial"))).some(name => name.endsWith(".gz")));
});
