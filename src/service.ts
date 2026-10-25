import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { FileKVStore, QQBot, kvSessionPersistence, type QQBotOptions, type QQBotEventMap, type Middleware } from "@tencent-connect/qqbot-nodejs";
import { PiRunner, type AgentRunner } from "./agent.js";
import { ChatBridge } from "./bridge.js";
import { readSecret, type Config } from "./config.js";
import { storageKey } from "./conversation.js";

export interface Gateway extends Pick<QQBot, "start" | "stop" | "sendText"> {
  on<K extends keyof QQBotEventMap>(event: K, handler: QQBotEventMap[K]): unknown;
  use(...middleware: Middleware[]): unknown;
}
export interface ServiceOptions {
  signal?: AbortSignal;
  runner?: AgentRunner;
  createGateway?: (options: QQBotOptions) => Gateway;
  lockRoot?: string;
}
export type ServiceStatus = "connecting" | "ready" | "reconnecting" | "stopping" | "stopped" | "failed";

/** One gateway owner per app and OS user, shared by CLI and Pi extension. */
export class QQService {
  status: ServiceStatus = "connecting";
  readonly done: Promise<void>;
  private stopping = false;

  private constructor(
    private bot: Gateway,
    private bridge: ChatBridge,
    private controller: AbortController,
    store: FileKVStore,
    release: () => Promise<void>,
    unlinkSignal: () => void,
    report: (code: string) => void,
  ) {
    bot.on("ready", () => { if (!this.stopping) { this.status = "ready"; report("ready"); } });
    bot.on("resumed", () => { if (!this.stopping) { this.status = "ready"; report("resumed"); } });
    bot.on("disconnected", () => { if (!this.stopping) this.status = "reconnecting"; });
    bot.on("error", () => report("gateway_error"));
    // Handle here: QQBot's message event emitter swallows listener rejections.
    bot.use(async ctx => {
      try { await bridge.handle(ctx.message); }
      catch { report("inbound_failed"); }
    });
    this.done = (async () => {
      let failed = false;
      try { await bot.start(controller.signal); }
      catch { failed = !controller.signal.aborted; if (failed) report("gateway_failed"); }
      finally {
        this.stopping = true;
        this.status = "stopping";
        unlinkSignal();
        try {
          bot.stop();
          await bridge.stop();
          store.flush();
        } catch { failed = true; report("shutdown_failed"); }
        finally {
          try { await release(); }
          catch { failed = true; report("lock_release_failed"); }
        }
        this.status = failed ? "failed" : "stopped";
      }
    })();
  }

  static async start(config: Config, report: (code: string) => void = () => {}, options: ServiceOptions = {}): Promise<QQService> {
    // Diagnostic callbacks must never destabilize the gateway or expose API payloads.
    const log = (code: string) => { try { report(code); } catch {} };
    const secret = readSecret(config);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const unlink = () => options.signal?.removeEventListener("abort", abort);
    let release: (() => Promise<void>) | undefined;
    try {
      controller.signal.throwIfAborted();
      const lockDir = join(options.lockRoot ?? join(homedir(), ".pi", "qqbot-locks"), storageKey(config.appId));
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      try {
        release = await lockfile.lock(lockDir, {
          retries: 0,
          onCompromised: () => { log("lock_compromised"); controller.abort(); },
        });
      } catch { throw new Error("无法获取机器人实例锁：请确认同一 AppID 没有在其他 CLI 或 Pi 窗口运行，且锁目录可写。"); }
      const runner = options.runner ?? await PiRunner.create(config);
      controller.signal.throwIfAborted();
      const gatewayDir = join(config.dataDir, "gateway", storageKey(config.appId));
      await mkdir(gatewayDir, { recursive: true, mode: 0o700 });
      const store = new FileKVStore({ dir: gatewayDir, logger: { error: () => log("persistence_failed") } });
      const bot = (options.createGateway ?? (opts => new QQBot(opts)))({
        appId: config.appId, appSecret: secret, accountId: config.appId,
        transport: "websocket", tokenPrefetch: "sync", markdownSupport: false,
        intents: 1 << 25,
        reconnect: { maxAttempts: 20 },
        sessionPersistence: kvSessionPersistence({ store, accountId: config.appId }),
      });
      const bridge = new ChatBridge(config, runner, bot, log);
      return new QQService(bot, bridge, controller, store, release, unlink, log);
    } catch (error) {
      unlink();
      if (release) await release().catch(() => log("lock_release_failed"));
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.status = "stopping";
      this.controller.abort();
      this.bot.stop();
      // Stop accepting work immediately; done also waits for this drain.
      void this.bridge.stop().catch(() => {});
    }
    await this.done;
  }
}
