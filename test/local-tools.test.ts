import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { PiRunner } from "../src/agent.js";
import { configSchema, readConfig } from "../src/config.js";
import { config } from "./helpers.js";

test("local tool configuration is opt-in, validates names and requires an existing absolute cwd", async () => {
  const cfg = config();
  assert.equal(cfg.localTools.enabled, false);
  assert.deepEqual(cfg.localTools.allowUsers, []);
  assert.equal(cfg.groups.g!.allowTools, false);
  for (const localTools of [
    { enabled: true }, { enabled: true, cwd: "relative" },
    { names: ["arbitrary_extension"] }, { names: [] },
  ]) assert.equal(configSchema.safeParse({ appId: "app", localTools }).success, false);
  const file = join(cfg.dataDir, "config.json");
  await writeFile(file, JSON.stringify({ ...cfg, localTools: { enabled: true, cwd: join(cfg.dataDir, "missing") } }));
  await assert.rejects(readConfig(file), /localTools.cwd/);
  await writeFile(file, JSON.stringify({ ...cfg, localTools: { enabled: true, cwd: file } }));
  await assert.rejects(readConfig(file), /localTools.cwd/);
});

test("real Pi tools execute in configured cwd, remain scoped, obey revocation and cancel shell children", { timeout: 30000 }, async t => {
  const cfg = config();
  cfg.agentDir = join(cfg.dataDir, "agent");
  const cwd = join(cfg.dataDir, "work");
  await mkdir(cwd);
  await mkdir(cfg.agentDir);
  cfg.localTools = { enabled: true, cwd, allowUsers: ["alice"], names: ["read", "write", "edit", "bash"] };
  type Request = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
  const requests: Request[] = [];
  let calls: Array<{ name: string; arguments: object }> = [];
  let answer = "done";
  let serial = 0;
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    const call = calls.shift();
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${++serial}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: answer };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
    ]) res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "test", choices: [choice] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await writeFile(join(cfg.agentDir, "models.json"), JSON.stringify({ providers: { test: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fake",
    models: [{ id: "test", contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(cwd, "AGENTS.md"), "PRIVATE_WORKSPACE_INSTRUCTIONS");
  const signal = new AbortController().signal;
  const runner = await PiRunner.create(cfg);
  const enabled = { allowLocalTools: true };
  calls = [
    { name: "write", arguments: { path: "test.txt", content: "before" } },
    { name: "edit", arguments: { path: "test.txt", edits: [{ oldText: "before", newText: "after" }] } },
    { name: "read", arguments: { path: "test.txt" } },
    { name: "bash", arguments: { command: "pwd; cat test.txt; printf shell-ok > shell.txt" } },
  ];
  assert.equal(await runner.run("alice", "PRIVATE_ALICE", "Use the requested tools", signal, enabled), "done");
  assert.equal(await readFile(join(cwd, "test.txt"), "utf8"), "after");
  assert.equal(await readFile(join(cwd, "shell.txt"), "utf8"), "shell-ok");
  const resultMessages = requests.at(-1)!.messages.filter(m => m.role === "tool");
  assert.ok(JSON.stringify(resultMessages).includes(cwd));
  assert.ok(JSON.stringify(resultMessages).includes("after"));
  assert.ok(!JSON.stringify(requests).includes("PRIVATE_WORKSPACE_INSTRUCTIONS"));
  const names = () => (requests.at(-1)!.tools ?? []).map(tool => tool.function.name).sort();
  assert.deepEqual(names(), [...cfg.localTools.names].sort());
  await runner.run("bob", "OTHER_MEMBER", "Chat", signal, enabled);
  assert.ok(!JSON.stringify(requests.at(-1)).includes("PRIVATE_ALICE"));
  // The deployed extension forwards requests through the host registry too.
  const runtime = await ModelRuntime.create({ modelsPath: join(cfg.agentDir, "models.json"), authPath: join(cfg.agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const hosted = PiRunner.fromHost({ ...cfg, model: undefined }, () => ({ model: registry.find("test", "test"), modelRegistry: registry }));
  calls = [{ name: "write", arguments: { path: "host.txt", content: "host-tool-ok" } }];
  await hosted.run("hosted", "HOST_TOOL", "Chat", signal, enabled);
  assert.equal(await readFile(join(cwd, "host.txt"), "utf8"), "host-tool-ok");
  // Authorization is supplied by the bridge for each turn, not restored from history.
  await runner.run("alice", "REVOKED", "Chat", signal);
  assert.deepEqual(names(), []);
  assert.ok(JSON.stringify(requests.at(-1)).includes("PRIVATE_ALICE"));
  cfg.localTools.names = ["read"];
  const reopened = await PiRunner.create(cfg);
  calls = [{ name: "bash", arguments: { command: "touch forbidden.txt" } }];
  await reopened.run("alice", "READ_ONLY", "Chat", signal, enabled);
  assert.deepEqual(names(), ["read"]);
  await assert.rejects(access(join(cwd, "forbidden.txt")));
  answer = "[]";
  assert.deepEqual(await reopened.suggestMemories("remember preference", signal), []);
  assert.deepEqual(names(), []);
  assert.ok(!JSON.stringify(requests.at(-1)).includes("PRIVATE_ALICE"));
  answer = JSON.stringify({ experience: null, facts: [] });
  const reflectionInput = { text: "a meaningful conversation", character: "a quiet reader", reply: "OLD_RETRIEVED_MEMORY_MUST_NOT_BE_REEXTRACTED" };
  assert.deepEqual(await hosted.reflect(reflectionInput, signal), { experience: null, facts: [] });
  assert.ok(!JSON.stringify(requests.at(-1)).includes("OLD_RETRIEVED_MEMORY_MUST_NOT_BE_REEXTRACTED"));
  assert.deepEqual(names(), []);
  assert.ok(!JSON.stringify(requests.at(-1)).includes("PRIVATE_ALICE"));
  answer = JSON.stringify({ experience: null, facts: [], stage: 5 });
  await assert.rejects(hosted.reflect({ text: "a meaningful conversation", character: "a quiet reader" }, signal));
  cfg.localTools.enabled = false;
  await reopened.run("alice", "MASTER_OFF", "Chat", signal, enabled);
  assert.deepEqual(names(), []);
  cfg.localTools.enabled = true;
  cfg.localTools.names = ["bash"];
  answer = "done";
  calls = [{ name: "bash", arguments: { command: "printf ready > started; sleep 1; printf late > should-not-exist" } }];
  const controller = new AbortController();
  const pending = reopened.run("cancel", "CANCEL", "Chat", controller.signal, enabled);
  const rejected = assert.rejects(pending);
  let started = false;
  for (let i = 0; i < 300; i++) {
    try { await access(join(cwd, "started")); started = true; break; } catch { await delay(10); }
  }
  controller.abort();
  await rejected;
  assert.ok(started, "shell must actually start before cancellation");
  await delay(1100);
  await assert.rejects(access(join(cwd, "should-not-exist")));
});
