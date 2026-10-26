import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UserError } from "./content.js";
import type { Config } from "./config.js";

export interface MemoryRecord {
  id: string;
  scope: string;
  kind: "fact" | "profile";
  name: string;
  text: string;
  status: "confirmed" | "pending";
  source: string;
  createdAt: number;
  expiresAt: number | null;
}
export const profileFields = ["name", "language", "replyStyle", "timezone", "interests"] as const;

/** Scoped, transactional storage. Only confirmed records are eligible for retrieval. */
export class MemoryStore {
  private database?: DatabaseSync;
  private closed = false;
  constructor(private root: string, private options: Config["memory"], private now = Date.now) {}

  private get db(): DatabaseSync {
    if (this.closed) throw new Error("Memory store closed");
    if (this.database) return this.database;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "memory.sqlite");
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;");
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 1) throw new Error("Unsupported memory schema");
      db.exec(`CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, status);
      CREATE TABLE IF NOT EXISTS settings (scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (chat TEXT PRIMARY KEY, mode TEXT NOT NULL, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (scope TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(scope,key));
      PRAGMA user_version=1;`);
      this.database = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  close(): void { if (!this.closed) { this.database?.close(); this.closed = true; } }

  /** Epoch prevents switching group → member → group from resurrecting the old shared session. */
  route(chat: string, mode: "group" | "member"): number {
    const row = this.db.prepare("SELECT mode, epoch FROM routes WHERE chat=?").get(chat);
    if (row?.mode === mode) return Number(row.epoch);
    const epoch = row ? Number(row.epoch) + 1 : 0;
    this.db.prepare("INSERT INTO routes(chat,mode,epoch) VALUES(?,?,?) ON CONFLICT(chat) DO UPDATE SET mode=excluded.mode,epoch=excluded.epoch")
      .run(chat, mode, epoch);
    return epoch;
  }
  resetRoute(chat: string): void { this.db.prepare("UPDATE routes SET epoch=epoch+1 WHERE chat=?").run(chat); }

  registerConversation(scope: string, key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO conversations(scope,key) VALUES(?,?)").run(scope, key);
  }
  conversationKeys(scope: string): string[] {
    return this.db.prepare("SELECT key FROM conversations WHERE scope=?").all(scope).map(row => String(row.key));
  }
  enabled(scope: string): boolean {
    return this.options.enabled && this.db.prepare("SELECT enabled FROM settings WHERE scope=?").get(scope)?.enabled !== 0;
  }
  setEnabled(scope: string, enabled: boolean): void {
    this.db.prepare("INSERT INTO settings(scope,enabled) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled")
      .run(scope, enabled ? 1 : 0);
  }
  hasExpired(scope: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM memories WHERE scope=? AND status='confirmed' AND expiresAt<=? LIMIT 1").get(scope, this.now());
  }
  expire(scope: string): void {
    this.db.prepare("DELETE FROM memories WHERE scope=? AND expiresAt<=?").run(scope, this.now());
    this.checkpoint();
  }
  private checkpoint(): void { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }

  list(scope: string, status: "confirmed" | "pending" = "confirmed"): MemoryRecord[] {
    this.db.prepare("DELETE FROM memories WHERE scope=? AND status='pending' AND expiresAt<=?").run(scope, this.now());
    return this.db.prepare("SELECT * FROM memories WHERE scope=? AND status=? AND (expiresAt IS NULL OR expiresAt>?) ORDER BY createdAt DESC, id")
      .all(scope, status, this.now()) as unknown as MemoryRecord[];
  }
  find(scope: string, id: string): MemoryRecord | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE scope=? AND id=?").get(scope, id) as unknown as MemoryRecord | undefined;
  }

  add(scope: string, text: string, source: string, options: { name?: string; pending?: boolean } = {}): MemoryRecord {
    const content = text.trim();
    if (!content || content.length > 1000) throw new UserError("记忆内容需要 1–1000 字。");
    if (!this.enabled(scope)) throw new UserError("当前作用域的长期记忆已关闭。");
    const name = options.name ?? "";
    if (name && !(profileFields as readonly string[]).includes(name)) throw new UserError(`画像字段支持：${profileFields.join(", ")}`);
    const kind = name ? "profile" : "fact";
    const status = options.pending ? "pending" : "confirmed";
    this.db.prepare("DELETE FROM memories WHERE scope=? AND status='pending' AND expiresAt<=?").run(scope, this.now());
    const duplicate = this.db.prepare("SELECT * FROM memories WHERE scope=? AND kind=? AND name=? AND text=? AND status=? AND (expiresAt IS NULL OR expiresAt>?)")
      .get(scope, kind, name, content, status, this.now()) as unknown as MemoryRecord | undefined;
    if (duplicate) return duplicate;
    const existing = name ? this.db.prepare("SELECT id FROM memories WHERE scope=? AND kind='profile' AND name=?").get(scope, name) : undefined;
    const count = Number(this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND (expiresAt IS NULL OR expiresAt>?)").get(scope, this.now())?.n);
    if (!existing && count >= this.options.maxPerScope) throw new UserError("记忆数量已达上限，请先用 /forget 删除不再需要的条目。");
    const days = options.pending ? 7 : this.options.retentionDays;
    const row: MemoryRecord = {
      id: existing ? String(existing.id) : randomUUID().replaceAll("-", "").slice(0, 12),
      scope, kind, name, text: content, source, status, createdAt: this.now(),
      expiresAt: days ? this.now() + days * 86400000 : null,
    };
    this.db.prepare(`INSERT INTO memories(id,scope,kind,name,text,status,source,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET text=excluded.text,status=excluded.status,source=excluded.source,createdAt=excluded.createdAt,expiresAt=excluded.expiresAt`)
      .run(row.id, row.scope, row.kind, row.name, row.text, row.status, row.source, row.createdAt, row.expiresAt);
    return row;
  }
  accept(scope: string, id: string): boolean {
    if (!this.enabled(scope)) return false;
    const days = this.options.retentionDays;
    return Number(this.db.prepare("UPDATE memories SET status='confirmed',createdAt=?,expiresAt=? WHERE scope=? AND id=? AND status='pending' AND expiresAt>?")
      .run(this.now(), days ? this.now() + days * 86400000 : null, scope, id, this.now()).changes) > 0;
  }
  remove(scope: string, id: string): boolean {
    const result = id === "all"
      ? this.db.prepare("DELETE FROM memories WHERE scope=?").run(scope)
      : this.db.prepare("DELETE FROM memories WHERE scope=? AND id=?").run(scope, id);
    this.checkpoint();
    return Number(result.changes) > 0;
  }

  context(scope: string, query: string): MemoryRecord[] {
    if (!this.enabled(scope)) return [];
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const terms = words.flatMap(w => /\p{Script=Han}/u.test(w) ? Array.from({ length: Math.max(1, w.length - 1) }, (_, i) => w.slice(i, i + 2)) : [w]);
    const score = (r: MemoryRecord) => (r.kind === "profile" ? 100 : 0) + terms.reduce((n, term) => n + (r.text.toLowerCase().includes(term) ? 1 : 0), 0);
    const candidates = this.list(scope).sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt);
    const selected: MemoryRecord[] = [];
    let size = 0;
    for (const item of candidates) {
      if (selected.length >= this.options.maxInjected) break;
      if (size + item.text.length > this.options.maxInjectedChars) continue;
      selected.push(item); size += item.text.length;
    }
    return selected;
  }
}
