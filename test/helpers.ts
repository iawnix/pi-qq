import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { configSchema } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const directories: string[] = [];
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export function config() {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-qq-config-test-"));
  directories.push(dataDir);
  const parsed = configSchema.parse({ appId: "app", dataDir, allowUsers: ["alice", "bob"], groups: { g: { admins: ["admin"] } }, model: { provider: "test", id: "test" } });
  return { ...parsed, model: parsed.model! };
}
let id = 0;
export function message(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  const messageId = `m${++id}`;
  const timestamp = new Date().toISOString();
  return {
    kind: "c2c", rawEventType: "C2C_MESSAGE_CREATE", senderId: "alice", content: "hello", messageId, timestamp,
    raw: { id: messageId, content: "hello", timestamp, author: { user_openid: "alice" } },
    replyTarget: { scope: "c2c", targetId: "alice", msgId: messageId }, ...overrides,
  };
}
export function groupMessage(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  return message({ kind: "group", groupOpenid: "g", rawEventType: "GROUP_AT_MESSAGE_CREATE", replyTarget: { scope: "group", targetId: "g" }, ...overrides });
}
