import { createHash } from "node:crypto";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

export function conversationKey(appId: string, msg: QQBotInboundMessage): string {
  return JSON.stringify([appId, msg.replyTarget.scope, msg.replyTarget.targetId]);
}

export function storageKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function cleanContent(msg: QQBotInboundMessage, appId?: string): string {
  let text = msg.content;
  if (appId && msg.replyTarget.scope === "group") {
    text = text.split(`<@${appId}>`).join("").split(`<@!${appId}>`).join("");
  }
  for (const mention of msg.mentions ?? []) {
    if (!mention.is_you) continue;
    // OpenIDs are opaque; never interpolate them into a regular expression.
    const id = mention.member_openid ?? mention.id ?? mention.user_openid;
    if (id) text = text.split(`<@${id}>`).join("").split(`<@!${id}>`).join("");
  }
  return text.trim();
}

export function isMentioned(msg: QQBotInboundMessage): boolean {
  return msg.rawEventType === "GROUP_AT_MESSAGE_CREATE" || !!msg.mentions?.some(m => m.is_you);
}

export interface HistoryEntry { messageId: string; senderId: string; text: string }

/** Consumed history advances only to the snapshot used by this run. */
export class PendingHistory {
  private entries = new Map<string, HistoryEntry[]>();
  constructor(private limit: number) {}
  append(key: string, entry: HistoryEntry): void {
    if (!this.limit) return;
    const items = this.entries.get(key) ?? [];
    items.push(entry);
    this.entries.set(key, items.slice(-this.limit));
  }
  snapshot(key: string): HistoryEntry[] { return [...(this.entries.get(key) ?? [])]; }
  consume(key: string, snapshot: HistoryEntry[]): void {
    const ids = new Set(snapshot.map(e => e.messageId));
    const remaining = (this.entries.get(key) ?? []).filter(e => !ids.has(e.messageId));
    if (remaining.length) this.entries.set(key, remaining);
    else this.entries.delete(key);
  }
  clear(key: string): void { this.entries.delete(key); }
}

/** True TTL deduplication; separate from conversation history and gateway resume. */
export class Deduplicator {
  private seen = new Map<string, number>();
  constructor(private ttlMs = 600000, private max = 10000) {}
  accept(id: string, now = Date.now()): boolean {
    for (const [key, expiry] of this.seen) {
      if (expiry > now) break;
      this.seen.delete(key);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + this.ttlMs);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}

/** Fixed-window admission budget. Only accepted model requests consume budget. */
export class RequestBudget {
  private windows = new Map<string, { count: number; expires: number }>();
  constructor(private windowMs: number) {}
  accept(limits: Array<[string, number]>, now = Date.now()): boolean {
    for (const [key, value] of this.windows) if (value.expires <= now) this.windows.delete(key);
    if (limits.some(([key, max]) => (this.windows.get(key)?.count ?? 0) >= max)) return false;
    for (const [key] of limits) {
      const value = this.windows.get(key) ?? { count: 0, expires: now + this.windowMs };
      value.count++;
      this.windows.set(key, value);
    }
    return true;
  }
}

/** Bounded replies, preserving Unicode code points. Platform quotas still apply. */
export function replyChunks(text: string, limit = 4000, maxChunks = 3): string[] {
  const points = Array.from(text.trim());
  const suffix = "\n（回复过长，剩余内容请继续询问。）";
  if (points.length > limit * maxChunks) points.splice(limit * maxChunks - Array.from(suffix).length, Infinity, ...Array.from(suffix));
  const chunks: string[] = [];
  for (let i = 0; i < points.length; i += limit) chunks.push(points.slice(i, i + limit).join(""));
  return chunks;
}
