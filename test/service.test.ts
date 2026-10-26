import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Middleware, QQBotEventMap } from "@tencent-connect/qqbot-nodejs";
import { QQService, type Gateway } from "../src/service.js";
import { config, deferred } from "./helpers.js";

class FakeGateway implements Gateway {
  ready?: QQBotEventMap["ready"];
  middleware: Middleware[] = [];
  private ended = deferred();
  constructor(private fail = false) {}
  on<K extends keyof QQBotEventMap>(event: K, handler: QQBotEventMap[K]) {
    if (event === "ready") this.ready = handler as QQBotEventMap["ready"];
    return this;
  }
  use(...middleware: Middleware[]) { this.middleware.push(...middleware); return this; }
  async start(signal?: AbortSignal): Promise<void> {
    if (this.fail) throw new Error("SECRET_FROM_SERVER");
    const stop = () => this.stop();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    this.ready?.({});
    try { await this.ended.promise; }
    finally { signal?.removeEventListener("abort", stop); }
  }
  stop() { this.ended.resolve(); }
  async sendText() { return { id: "reply", timestamp: Date.now() }; }
}

test("service prevents duplicate gateways, handles stop, and releases lock after failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-qq-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = config();
  cfg.dataDir = root;
  cfg.secretEnv = "PI_QQ_TEST_SECRET";
  const oldSecret = process.env[cfg.secretEnv];
  process.env[cfg.secretEnv] = "fake";
  t.after(() => { if (oldSecret === undefined) delete process.env[cfg.secretEnv]; else process.env[cfg.secretEnv] = oldSecret; });
  const runner = { run: async () => "ok", reset: async () => {}, purge: async () => {} };
  const reports: string[] = [];
  const gateway = new FakeGateway();
  const options = { lockRoot: join(root, "locks"), runner, createGateway: () => gateway };
  const service = await QQService.start(cfg, code => reports.push(code), options);
  t.after(() => service.stop());
  assert.equal(service.status, "ready");
  assert.equal(gateway.middleware.length, 1);
  await assert.rejects(QQService.start(cfg, () => {}, options), /实例锁/);
  await Promise.all([service.stop(), service.stop()]);
  assert.equal(service.status, "stopped");
  const failed = await QQService.start(cfg, code => reports.push(code), { ...options, createGateway: () => new FakeGateway(true) });
  await failed.done;
  assert.equal(failed.status, "failed");
  assert.ok(reports.includes("gateway_failed"));
  assert.ok(!JSON.stringify(reports).includes("SECRET"));
  const controller = new AbortController();
  const next = await QQService.start(cfg, () => {}, { ...options, signal: controller.signal, createGateway: () => new FakeGateway() });
  t.after(() => next.stop());
  controller.abort();
  await next.done;
  assert.equal(next.status, "stopped");
});
