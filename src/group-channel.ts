import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { Config } from "./config.js";
import { cleanContent, isMentioned, RequestBudget } from "./conversation.js";
import { UserError } from "./content.js";

export interface GroupLine {
  messageId: string; senderId: string; role: "member" | "bot"; text: string; timestamp: string;
}
export interface GroupDecision { text: string; history: GroupLine[]; character: string }
export const groupReplyMode = (group: Config["groups"][string]) => group.replyMode ?? (group.requireMention ? "mention" : "all");

/** Public, delivered group text only. Never fetch private sessions into this buffer. */
export class GroupChannels {
  private history = new Map<string, GroupLine[]>();
  private stats = new Map<string, { mentioned: number; ordinary: number }>();
  private decisions = new Map<string, { busy: boolean; nextCheck: number; nextReply: number; window: number; count: number }>();
  private outgoing = new Set<Promise<unknown>>();
  private sentIds = new Map<string, number>();
  private budget: RequestBudget;
  private stopped = false;
  constructor(private config: Config, private sink: { sendText(target: ReplyTarget, text: string): Promise<unknown> }, private now = Date.now) {
    this.budget = new RequestBudget(config.rateLimit.windowMs);
  }
  private group(id: string) {
    if (!Object.hasOwn(this.config.groups, id)) throw new UserError("该群未在配置中授权。");
    return this.config.groups[id]!;
  }
  list() {
    return Object.entries(this.config.groups).map(([groupId, group]) => ({ groupId, name: group.name,
      replyMode: groupReplyMode(group), allowProactive: group.allowProactive,
      received: this.stats.get(groupId) ?? { mentioned: 0, ordinary: 0 } }));
  }
  ownMessage(id: string, messageId: string): boolean {
    for (const [key, expires] of this.sentIds) if (expires <= this.now()) this.sentIds.delete(key);
    return this.sentIds.has(JSON.stringify([id, messageId]));
  }
  observe(msg: QQBotInboundMessage): void {
    const id = msg.replyTarget.targetId;
    this.group(id);
    const counts = this.stats.get(id) ?? { mentioned: 0, ordinary: 0 };
    if (isMentioned(msg)) counts.mentioned++; else counts.ordinary++;
    this.stats.set(id, counts);
    const text = cleanContent(msg, this.config.appId);
    if (text) this.append(id, { messageId: msg.messageId, senderId: msg.senderId, role: "member", text: text.slice(0, 2000), timestamp: msg.timestamp });
  }
  recent(id: string): GroupLine[] { return (this.history.get(id) ?? []).map(row => ({ ...row })); }
  private append(id: string, line: GroupLine): void {
    if (!this.config.historyLimit) return;
    this.history.set(id, [...(this.history.get(id) ?? []), line].slice(-Math.min(this.config.historyLimit, 30)));
  }
  clear(id?: string): void { if (id) this.history.delete(id); else this.history.clear(); }
  reserveDecision(id: string): boolean {
    const settings = this.group(id).smartReply;
    const now = this.now();
    const state = this.decisions.get(id) ?? { busy: false, nextCheck: 0, nextReply: 0, window: now, count: 0 };
    if (now - state.window >= 3600000) { state.window = now; state.count = 0; }
    this.decisions.set(id, state);
    if (state.busy || now < state.nextCheck || now < state.nextReply || state.count >= settings.maxPerHour) return false;
    state.busy = true;
    state.nextCheck = now + settings.checkIntervalMs;
    return true;
  }
  commitDecision(id: string): boolean {
    const state = this.decisions.get(id);
    if (!state?.busy || this.now() < state.nextReply) return false;
    state.count++;
    state.nextReply = this.now() + this.group(id).smartReply.cooldownMs;
    return true;
  }
  finishDecision(id: string): void { const state = this.decisions.get(id); if (state) state.busy = false; }
  recordReply(id: string, text: string, messageId = ""): void {
    const state = this.decisions.get(id) ?? { busy: false, nextCheck: 0, nextReply: 0, window: this.now(), count: 0 };
    state.nextReply = this.now() + this.group(id).smartReply.cooldownMs;
    this.decisions.set(id, state);
    this.append(id, { messageId, senderId: this.config.appId, role: "bot", text: text.slice(0, 2000), timestamp: new Date(this.now()).toISOString() });
    if (messageId) {
      this.sentIds.set(JSON.stringify([id, messageId]), this.now() + 600000);
      if (this.sentIds.size > 1000) this.sentIds.delete(this.sentIds.keys().next().value!);
    }
  }
  async send(id: string, text: string, signal?: AbortSignal): Promise<string> {
    if (this.stopped) throw new UserError("QQ 服务已停止。");
    if (!this.group(id).allowProactive) throw new UserError("该群尚未开启 allowProactive，请先配置并重启服务。");
    const content = text.trim();
    if (!content || Array.from(content).length > 4000) throw new UserError("主动消息需要 1–4000 字。");
    signal?.throwIfAborted();
    if (!this.budget.accept([["global", this.config.rateLimit.global], [id, this.config.rateLimit.perGroup]], this.now())) throw new UserError("主动消息发送频率已达上限，请稍后重试。");
    const request = Promise.resolve().then(async () => {
      signal?.throwIfAborted();
      if (this.stopped) throw new UserError("QQ 服务已停止。");
      try {
        // Deliberately omit msgId: this is a proactive push, not an expired reply.
        const receipt = await this.sink.sendText({ scope: "group", targetId: id }, content);
        const messageId = receipt && typeof receipt === "object" && "id" in receipt ? receipt.id : undefined;
        if (typeof messageId !== "string" || !messageId) throw new Error("Missing message receipt");
        this.recordReply(id, content, messageId);
        return messageId;
      } catch {
        throw new UserError("QQ 主动发送未确认成功，请检查群内发送结果、主动发言开关及平台额度，避免重复发送。");
      }
    });
    this.outgoing.add(request);
    try { return await request; } finally { this.outgoing.delete(request); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.outgoing]);
    this.clear();
  }
}
