import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createReadTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { ConversationStore, PiRunner } from "../src/agent.js";
import { config } from "./helpers.js";

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
});

test("real Pi SDK with local mock model: no tools/private resources; restore, isolate and reset history", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-qq-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta: { role: "assistant", content: "local answer" }, finish_reason: null },
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
  await mkdir(join(cfg.agentDir, "extensions"), { recursive: true });
  await writeFile(join(cfg.agentDir, "AGENTS.md"), "OWNER_PRIVATE_MARKER");
  await writeFile(join(cfg.agentDir, "SYSTEM.md"), "OWNER_SYSTEM_MARKER");
  await writeFile(join(cfg.agentDir, "extensions", "trap.ts"), 'throw new Error("Nested extension was loaded");');
  await writeFile(join(cfg.agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake-local-key",
    models: [{ id: "test", contextWindow: 32000, maxTokens: 1024 }],
  } } }));
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
});
