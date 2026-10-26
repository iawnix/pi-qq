import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createReadTool, SessionManager, ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ConversationStore, PiRunner } from "../src/agent.js";
import { ChatBridge } from "../src/bridge.js";
import { config, message, groupMessage } from "./helpers.js";
import sharp from "sharp";

test("session store reopens chat and reset preserves other chat namespaces", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-qq-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ConversationStore(root);
  const first = await store.open("app:c2c:alice");
  const other = await store.open("app:group:alice");
  assert.notEqual(first.sessions, other.sessions);
  assert.deepEqual(await new ConversationStore(root).open("app:c2c:alice"), first);
  await store.reset("app:c2c:alice");
  assert.notEqual((await store.open("app:c2c:alice")).sessions, first.sessions);
  assert.deepEqual(await store.open("app:group:alice"), other);
  await store.purge("app:c2c:alice");
  assert.deepEqual(await store.open("app:c2c:alice"), first);
  assert.deepEqual(await store.open("app:group:alice"), other);
});

test("history migration persists with an empty destination and is retry-safe without replaying reset generations", async () => {
  const cfg = config();
  const store = new ConversationStore(cfg.dataDir);
  let old = await store.open("source");
  SessionManager.continueRecent(old.cwd, old.sessions).appendMessage({ role: "user", content: "DISCARDED_GENERATION", timestamp: Date.now() });
  await store.reset("source");
  old = await store.open("source");
  SessionManager.continueRecent(old.cwd, old.sessions).appendMessage({ role: "user", content: "ACTIVE_GENERATION", timestamp: Date.now() });
  await store.mergeHistory("source", "destination");
  await new ConversationStore(cfg.dataDir).mergeHistory("source", "destination");
  const target = await store.open("destination");
  const context = JSON.stringify(SessionManager.continueRecent(target.cwd, target.sessions).buildSessionContext());
  assert.equal((context.match(/ACTIVE_GENERATION/g) ?? []).length, 1);
  assert.doesNotMatch(context, /DISCARDED_GENERATION/);
});

test("real Pi SDK with local mock model: no tools/private resources; restore, isolate and reset history", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-qq-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = [];
  const authorization: Array<string | undefined> = [];
  const image = { type: "image" as const, mimeType: "image/png", data: (await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer()).toString("base64") };
  let answer = "local answer";
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(parts).toString());
    requests.push(request);
    authorization.push(req.headers.authorization);
    if (request.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "image-result", choices: [{ message: { role: "assistant", content: "generated", images: [{ image_url: { url: `data:image/png;base64,${image.data}` } }] } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: answer }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]) res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "test", choices: [choice] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const cfg = config();
  cfg.agentDir = join(root, "agent");
  cfg.dataDir = join(root, "data");
  cfg.images.generationModel = { provider: "openrouter", id: "google/gemini-2.5-flash-image" };
  await mkdir(join(cfg.agentDir, "extensions"), { recursive: true });
  await writeFile(join(cfg.agentDir, "AGENTS.md"), "OWNER_PRIVATE_MARKER");
  await writeFile(join(cfg.agentDir, "SYSTEM.md"), "OWNER_SYSTEM_MARKER");
  await writeFile(join(cfg.agentDir, "extensions", "trap.ts"), 'throw new Error("Nested extension was loaded");');
  await writeFile(join(cfg.agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake-local-key",
    models: [{ id: "test", input: ["text", "image"], contextWindow: 32000, maxTokens: 1024 }, { id: "text-only", input: ["text"] }],
  }, openrouter: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake-local-key" } } }));
  const signal = new AbortController().signal;
  const runner = await PiRunner.create(cfg);
  assert.equal(await runner.run("chat-a", "FIRST_CHAT_PRIVATE", "Chat instructions", signal), "local answer");
  // Pi 1.3+ restores recorded tools by default. Explicit QQ policy must override
  // a transcript from an older configuration that had local tools enabled.
  const stored = await new ConversationStore(cfg.dataDir).open("chat-a");
  const transcript = SessionManager.continueRecent(stored.cwd, stored.sessions);
  transcript.appendMessage({
    role: "system", content: "", timestamp: Date.now(),
    toolsAdded: [createReadTool(stored.cwd), createBashTool(stored.cwd)].map(({ name, description, parameters }) => ({ name, description, parameters })),
  });
  // A new runner simulates restarting the service, not merely reusing an in-memory session.
  const reopened = await PiRunner.create(cfg);
  await reopened.run("chat-a", "SECOND_TURN", "Chat instructions", signal);
  await reopened.run("chat-b", "OTHER_CHAT", "Chat instructions", signal);
  await reopened.reset("chat-a");
  await reopened.run("chat-a", "AFTER_RESET", "Chat instructions", signal);
  assert.equal(requests.length, 4);
  assert.ok(JSON.stringify(requests[1]).includes("FIRST_CHAT_PRIVATE"));
  assert.ok(!JSON.stringify(requests[2]).includes("FIRST_CHAT_PRIVATE"));
  assert.ok(!JSON.stringify(requests[3]).includes("FIRST_CHAT_PRIVATE"));
  for (const request of requests) {
    assert.equal(request.tools?.length ?? 0, 0);
    assert.ok(!JSON.stringify(request).includes("OWNER_"));
    assert.ok(JSON.stringify(request).includes("Chat instructions"));
  }
  await reopened.run("visual", "FIRST_IMAGE", "Chat instructions", signal, { images: [image] });
  assert.ok(JSON.stringify(requests.at(-1)).includes("data:image/"));
  await reopened.run("visual", "FOLLOWUP", "Chat instructions", signal);
  assert.ok(JSON.stringify(requests.at(-1)).includes("FIRST_IMAGE"));
  await reopened.purge("visual");
  await reopened.run("visual", "AFTER_PURGE", "Chat instructions", signal);
  assert.ok(!JSON.stringify(requests.at(-1)).includes("FIRST_IMAGE"));
  assert.ok(!JSON.stringify(requests.at(-1)).includes("data:image/"));
  const beforeRejected = requests.length;
  cfg.model.id = "text-only";
  await assert.rejects(reopened.run("no-vision", "question", "Chat instructions", signal, { images: [image] }), /不支持图片/);
  assert.equal(requests.length, beforeRejected);
  cfg.model.id = "test";
  answer = '[{"text":"prefers concise answers"}]';
  assert.deepEqual(await reopened.suggestMemories("I prefer concise answers", signal), [{ text: "prefers concise answers" }]);
  assert.ok(!JSON.stringify(requests.at(-1)).includes("FIRST_CHAT_PRIVATE"));
  assert.deepEqual(await reopened.generateImage("draw a cat", [image], signal), [image]);
  assert.ok(JSON.stringify(requests.at(-1)).includes("draw a cat"));
  assert.ok(JSON.stringify(requests.at(-1)).includes("data:image/png"));
  assert.ok(!JSON.stringify(requests.at(-1)).includes("FIRST_CHAT_PRIVATE"));
  // Exercise real SDK compaction, checkpoint restore and continued replies with a local model.
  answer = "COMPACTED_SUMMARY_OR_REPLY";
  const compactConfig = { ...cfg, dataDir: join(root, "compacting"),
    context: { ...cfg.context, maxTokens: 4096, keepRecentTokens: 512 } };
  const compactRunner = await PiRunner.create(compactConfig);
  await compactRunner.run("budgeted", "OLD_CONTEXT_".repeat(1800), "Chat instructions", signal);
  assert.equal(await compactRunner.run("budgeted", "RECENT_FOLLOWUP ".repeat(300), "Chat instructions", signal), answer);
  assert.equal(await compactRunner.run("budgeted", "SECOND_RECENT_FOLLOWUP", "Chat instructions", signal), answer);
  const compactStore = new ConversationStore(compactConfig.dataDir);
  const compacted = await compactStore.open("budgeted");
  assert.notEqual(compacted.sessions.split("/").at(-1), "initial");
  const compactContext = SessionManager.continueRecent(compacted.cwd, compacted.sessions).buildSessionContext();
  assert.ok(compactContext.messages.some(m => m.role === "compactionSummary"));
  assert.equal(await (await PiRunner.create(compactConfig)).run("budgeted", "AFTER_SERVICE_RESTART", "Chat instructions", signal), answer);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /FIRST_CHAT_PRIVATE|OWNER_/);

  // Standalone startup uses Pi's saved default when no model override is given.
  await writeFile(join(cfg.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "test", defaultModel: "text-only" }));
  const defaultRunner = await PiRunner.create({ ...cfg, model: undefined });
  await defaultRunner.run("saved-default", "SAVED_DEFAULT", "Chat instructions", signal);
  assert.equal(requests.at(-1)!.model, "text-only");

  // Host-only provider and credentials: neither is present in the QQ config directory.
  const hostRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(root, "host-auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(hostRuntime);
  registry.registerProvider("host-only", {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: ["host-a", "host-b"].map(id => ({ id, name: id, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 })),
  });
  await hostRuntime.setRuntimeApiKey("host-only", "host-key-one");
  let current = registry.find("host-only", "host-a");
  const hostedConfig = { ...cfg, model: undefined, agentDir: join(root, "unused-agent-dir"), images: { ...cfg.images, generationModel: undefined } };
  const hosted = PiRunner.fromHost(hostedConfig, () => ({ model: current, modelRegistry: registry }));
  answer = "host answer";
  await hosted.run("host-chat", "HOST_FIRST", "Chat instructions", signal, { images: [image] });
  assert.equal(requests.at(-1)!.model, "host-a");
  assert.equal(authorization.at(-1), "Bearer host-key-one");
  assert.ok(JSON.stringify(requests.at(-1)).includes("data:image/"));
  current = registry.find("host-only", "host-b");
  await hostRuntime.setRuntimeApiKey("host-only", "host-key-two");
  await hosted.run("host-chat", "HOST_SECOND", "Chat instructions", signal);
  assert.equal(requests.at(-1)!.model, "host-b");
  assert.equal(authorization.at(-1), "Bearer host-key-two");
  assert.ok(JSON.stringify(requests.at(-1)).includes("HOST_FIRST"));
  assert.equal(requests.at(-1)!.tools?.length ?? 0, 0);
  assert.ok(!JSON.stringify(requests.at(-1)).includes("OWNER_"));
  const pinned = PiRunner.fromHost({ ...hostedConfig, model: { provider: "host-only", id: "host-a" } }, () => ({ model: current, modelRegistry: registry }));
  await pinned.run("host-pinned", "PINNED", "Chat instructions", signal);
  assert.equal(requests.at(-1)!.model, "host-a");
  assert.throws(() => PiRunner.fromHost(hostedConfig, () => ({ model: undefined, modelRegistry: registry })), /\/model/);
  registry.registerVirtualModel({ provider: "host-only", id: "auto", name: "Host router", contextWindow: 32000, maxTokens: 1024,
    route: () => ({ model: registry.find("host-only", "host-b")!, thinkingLevel: "off" }),
  });
  current = registry.find("host-only", "auto");
  await hosted.run("host-router", "ROUTED", "Chat instructions", signal);
  assert.equal(requests.at(-1)!.model, "host-b");
  // Real SDK transcript persistence, legacy group context import, and linked routing.
  const linked = { ...hostedConfig, dataDir: join(root, "linked-data"), groups: { g: { ...cfg.groups.g!, sessionScope: "member" as const } } };
  const reports: string[] = [];
  const sink = { sendText: async () => {} };
  let bridge = new ChatBridge(linked, PiRunner.fromHost(linked, () => ({ model: current, modelRegistry: registry })), sink, code => reports.push(code));
  await bridge.handle(message({ content: "LEGACY_PRIVATE_TEXT" }));
  await bridge.handle(groupMessage({ senderId: "group-alice", content: "LEGACY_GROUP_TEXT" }));
  await bridge.stop();
  linked.identityLinks = [{ privateUser: "alice", groupMembers: { g: "group-alice" } }];
  bridge = new ChatBridge(linked, PiRunner.fromHost(linked, () => ({ model: current, modelRegistry: registry })), sink, code => reports.push(code));
  await bridge.handle(groupMessage({ senderId: "group-alice", content: "LINKED_GROUP_NEW" }));
  assert.match(JSON.stringify(requests.at(-1)), /LEGACY_PRIVATE_TEXT/);
  assert.match(JSON.stringify(requests.at(-1)), /LEGACY_GROUP_TEXT/);
  await bridge.stop();
  bridge = new ChatBridge(linked, PiRunner.fromHost(linked, () => ({ model: current, modelRegistry: registry })), sink, code => reports.push(code));
  await bridge.handle(message({ content: "LINKED_PRIVATE_NEW" }));
  assert.match(JSON.stringify(requests.at(-1)), /LINKED_GROUP_NEW/);
  assert.equal((JSON.stringify(requests.at(-1)).match(/LEGACY_GROUP_TEXT/g) ?? []).length, 1);
  await bridge.handle(groupMessage({ senderId: "bob", content: "UNLINKED_OTHER_USER" }));
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /LEGACY_PRIVATE_TEXT|LINKED_PRIVATE_NEW/);
  await bridge.handle(groupMessage({ senderId: "admin", content: "/reset all" }));
  await bridge.handle(message({ content: "AFTER_GROUP_ADMIN_RESET" }));
  assert.match(JSON.stringify(requests.at(-1)), /LINKED_GROUP_NEW/);
  await bridge.handle(groupMessage({ senderId: "group-alice", content: "/reset" }));
  await bridge.handle(message({ content: "AFTER_LINKED_RESET" }));
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /LEGACY_PRIVATE_TEXT|LEGACY_GROUP_TEXT|LINKED_GROUP_NEW/);
  assert.deepEqual(reports, []);
  await bridge.stop();
});
