import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createAgentSession, createExtensionRuntime, ModelRuntime,
  SessionManager, SettingsManager, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { storageKey } from "./conversation.js";

export interface AgentRunner {
  run(key: string, prompt: string, systemPrompt: string, signal: AbortSignal): Promise<string>;
  reset(key: string): Promise<void>;
}

/** No discovery: nested sessions must not load this plugin or the owner's private context. */
export function chatResources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export class ConversationStore {
  constructor(private root: string) {}
  private directory(key: string): string { return join(this.root, "sessions", storageKey(key)); }

  async open(key: string): Promise<{ cwd: string; sessions: string }> {
    const base = this.directory(key);
    let generation = "initial";
    try { generation = (await readFile(join(base, "active"), "utf8")).trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!/^(initial|[a-f0-9-]{36})$/.test(generation)) throw new Error("Invalid session generation");
    const cwd = join(base, "workspace");
    const sessions = join(base, generation);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(sessions, { recursive: true, mode: 0o700 });
    return { cwd, sessions };
  }

  async reset(key: string): Promise<void> {
    const base = this.directory(key);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const temp = join(base, `active.${randomUUID()}.tmp`);
    await writeFile(temp, randomUUID(), { mode: 0o600 });
    await rename(temp, join(base, "active"));
  }
}

export class PiRunner implements AgentRunner {
  private store: ConversationStore;
  constructor(private config: Config, private modelRuntime: ModelRuntime) {
    this.store = new ConversationStore(config.dataDir);
  }

  static async create(config: Config): Promise<PiRunner> {
    const runtime = await ModelRuntime.create({
      authPath: join(config.agentDir, "auth.json"),
      modelsPath: join(config.agentDir, "models.json"),
      modelsStorePath: join(config.agentDir, "models-store.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    if (!runtime.getModel(config.model.provider, config.model.id)) throw new Error("配置中的 Pi 模型不存在，请核对 provider 和 id");
    return new PiRunner(config, runtime);
  }

  reset(key: string): Promise<void> { return this.store.reset(key); }

  async run(key: string, prompt: string, systemPrompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const { cwd, sessions } = await this.store.open(key);
    signal.throwIfAborted();
    const model = this.modelRuntime.getModel(this.config.model.provider, this.config.model.id);
    if (!model) throw new Error("模型不可用");
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.config.agentDir,
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: "off",
      // Pi 1.3+ can restore transcript tools; keep the explicit empty allowlist
      // so old sessions cannot reactivate local tools when resumed.
      tools: [],
      noTools: "all",
      resourceLoader: chatResources(systemPrompt),
      sessionManager: SessionManager.continueRecent(cwd, sessions),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    });
    const abort = () => { void session.abort().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      // A restored session can contain an old model selection. Pin the configured model.
      await session.setModel(model, { persist: false });
      signal.throwIfAborted();
      const start = session.messages.length;
      await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
      signal.throwIfAborted();
      // Error replies are often finalized messages, not rejected prompt() promises.
      const latest = session.messages.slice(start).filter(m => m.role === "assistant").at(-1);
      if (!latest || latest.stopReason === "error" || latest.stopReason === "aborted") throw new Error("模型未完成回复");
      const text = latest.content.filter(c => c.type === "text").map(c => c.text).join("").trim();
      if (!text) throw new Error("模型返回了空回复");
      return text;
    } finally {
      signal.removeEventListener("abort", abort);
      try { await session.abort(); }
      finally { session.dispose(); }
    }
  }
}
