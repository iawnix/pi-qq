import type { QQBotInboundMessage, ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import type { AgentRunner } from "./agent.js";
import type { Config } from "./config.js";
import { cleanContent, conversationKey, Deduplicator, isMentioned, PendingHistory, replyChunks, RequestBudget } from "./conversation.js";
import { QueueFullError, Scheduler, StoppedError } from "./scheduler.js";

export interface ReplySink { sendText(target: ReplyTarget, text: string): Promise<unknown> }

export class ChatBridge {
  private scheduler: Scheduler;
  private dedup = new Deduplicator();
  private history: PendingHistory;
  private stopped = false;
  private budget: RequestBudget;

  constructor(private config: Config, private runner: AgentRunner, private sink: ReplySink, private report: (code: string) => void = () => {}) {
    this.scheduler = new Scheduler(config.concurrency, config.queuePerChat, config.queueTotal);
    this.history = new PendingHistory(config.historyLimit);
    this.budget = new RequestBudget(config.rateLimit.windowMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.scheduler.stop();
  }

  async handle(msg: QQBotInboundMessage): Promise<void> {
    if (this.stopped || !msg.messageId || !msg.senderId || msg.senderIsBot) return;
    const scope = msg.replyTarget.scope;
    if (scope !== "c2c" && scope !== "group") return;
    if (!msg.replyTarget.targetId || (scope === "c2c" && msg.replyTarget.targetId !== msg.senderId)) return;
    const group = scope === "group" && Object.hasOwn(this.config.groups, msg.replyTarget.targetId)
      ? this.config.groups[msg.replyTarget.targetId] : undefined;
    if (scope === "group" ? !group : !this.config.allowUsers.includes(msg.senderId)) return;
    if (!this.fresh(msg)) return;
    const key = conversationKey(this.config.appId, msg);
    if (!this.dedup.accept(JSON.stringify([key, msg.messageId]))) return;
    const content = cleanContent(msg, this.config.appId);
    if (scope === "group" && group?.requireMention && !isMentioned(msg)) {
      this.history.append(key, { messageId: msg.messageId, senderId: msg.senderId, text: content.slice(0, 2000) });
      return;
    }

    try {
      if (content === "/help") {
        await this.reply(msg, "支持文本聊天。/stop 取消自己的请求；/reset 开始新对话（群聊仅配置的管理员可用）。");
        return;
      }
      if (content === "/stop") {
        const isAdmin = scope === "c2c" || group?.admins.includes(msg.senderId);
        const cancelled = this.scheduler.cancel(key, isAdmin ? undefined : msg.senderId);
        await this.reply(msg, cancelled ? "已请求停止。" : "没有可取消的请求。");
        return;
      }
      if (content === "/reset") {
        if (scope === "group" && !group?.admins.includes(msg.senderId)) {
          await this.reply(msg, "只有配置的群管理员可以重置群会话。");
          return;
        }
        const snapshot = this.history.snapshot(key);
        await this.scheduler.submit(key, msg.senderId, async signal => {
          signal.throwIfAborted();
          if (!this.fresh(msg)) return;
          await this.runner.reset(key);
          this.history.consume(key, snapshot);
          if (!signal.aborted) await this.reply(msg, "已开始新对话。");
        });
        return;
      }
      if (!content || msg.attachments?.length) {
        await this.reply(msg, "当前版本仅支持文本，请用文字描述你的问题。");
        return;
      }
      const limits: Array<[string, number]> = [
        ["global", this.config.rateLimit.global],
        [JSON.stringify([key, msg.senderId]), this.config.rateLimit.perUser],
      ];
      if (scope === "group") limits.push([key, this.config.rateLimit.perGroup]);
      if (!this.budget.accept(limits)) {
        this.report("rate_limited");
        return;
      }
      await this.scheduler.submit(key, msg.senderId, async stopSignal => {
        if (!this.fresh(msg)) return;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new Error("timeout")), this.config.timeoutMs);
        const signal = AbortSignal.any([stopSignal, timeout.signal]);
        const snapshot = this.history.snapshot(key);
        try {
          const prompt = JSON.stringify({
            scope, senderId: msg.senderId, history: snapshot,
            quoted: msg.msgType === 103 ? msg.msgElements?.slice(0, 1).map(e => ({ text: e.content?.slice(0, 8000) })) : undefined,
            text: content.slice(0, 16000),
          });
          const text = await this.runner.run(key, prompt, [this.config.systemPrompt, group?.prompt].filter(Boolean).join("\n\n"), signal);
          signal.throwIfAborted();
          this.history.consume(key, snapshot);
          for (const chunk of replyChunks(text)) {
            signal.throwIfAborted();
            await this.reply(msg, chunk);
          }
        } catch (error) {
          if (timeout.signal.aborted && !stopSignal.aborted) {
            await this.reply(msg, "处理超时，请缩短问题后重试。");
          } else if (!stopSignal.aborted) throw error;
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      if (error instanceof StoppedError || this.stopped) return;
      const busy = error instanceof QueueFullError;
      this.report(busy ? "queue_full" : "request_failed");
      try { await this.reply(msg, busy ? "正在处理的消息较多，请稍后再试。" : "处理失败，请稍后重试。"); }
      catch { this.report("error_reply_failed"); }
    }
  }

  private fresh(msg: QQBotInboundMessage): boolean {
    const age = Date.now() - Date.parse(msg.timestamp);
    return Number.isFinite(age) && age >= -30000 && age < this.config.replyWindowMs;
  }

  private async reply(msg: QQBotInboundMessage, text: string): Promise<void> {
    if (this.stopped || !this.fresh(msg)) return;
    // Always retain the originating msgId. Never silently upgrade to a proactive send.
    await this.sink.sendText({ ...msg.replyTarget, msgId: msg.messageId }, text);
  }
}
