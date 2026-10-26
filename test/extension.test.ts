import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import qqExtension from "../src/extension.js";
import { QQService } from "../src/service.js";
import { PiRunner } from "../src/agent.js";

test("Pi's actual extension loader loads source entry and registers command without starting gateway", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-qq-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions([resolve("src/extension.ts")], root, join(root, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0]!.commands.has("qq"));
  assert.ok(loaded.extensions[0]!.handlers.has("session_shutdown"));
});

test("extension starts with the host model and no model field or separate model files", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-qq-host-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "qqbot.json");
  await writeFile(path, JSON.stringify({ appId: "test", appSecret: "fake", agentDir: join(root, "empty") }));
  const previous = process.env.PI_QQ_CONFIG;
  process.env.PI_QQ_CONFIG = path;
  t.after(() => { if (previous === undefined) delete process.env.PI_QQ_CONFIG; else process.env.PI_QQ_CONFIG = previous; });
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(root, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const model = registry.getAll()[0]!;
  assert.ok(model);
  const notices: string[] = [];
  let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
  const api = {
    registerCommand: (_name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => { handler = command.handler; },
    on: () => () => {},
  } as unknown as ExtensionAPI;
  const ctx = { model, modelRegistry: registry, ui: { notify: (text: string) => { notices.push(text); } } } as unknown as ExtensionCommandContext;
  let starts = 0;
  let stops = 0;
  t.mock.method(QQService, "start", async (...[_config, _report, options]: Parameters<typeof QQService.start>) => {
    starts++;
    assert.ok(options?.runner instanceof PiRunner);
    return { status: "ready", stop: async () => { stops++; } } as unknown as QQService;
  });
  qqExtension(api);
  await handler!("start", ctx);
  assert.equal(starts, 1);
  assert.ok(notices.some(text => text.includes("ready")));
  await handler!("stop", ctx);
  assert.equal(stops, 1);
  ctx.model = undefined;
  await handler!("start", ctx);
  assert.equal(starts, 1);
  assert.match(notices.at(-1)!, /\/model/);
});
