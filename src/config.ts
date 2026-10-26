import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const ids = z.array(z.string().trim().min(1)).default([]);
const group = z.object({
  requireMention: z.boolean().default(true),
  sessionScope: z.enum(["group", "member"]).default("group"),
  admins: ids,
  prompt: z.string().max(8000).default(""),
}).strict();

export const configSchema = z.object({
  appId: z.string().trim().min(1),
  appSecret: z.string().trim().optional(),
  secretEnv: z.string().min(1).default("QQBOT_APP_SECRET"),
  allowUsers: ids,
  groups: z.record(z.string().min(1), group).default({}),
  model: z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict().optional(),
  agentDir: z.string().default(join(homedir(), ".pi", "agent")),
  dataDir: z.string().default(join(homedir(), ".pi", "qqbot")),
  systemPrompt: z.string().max(16000).default("你是 QQ 聊天助手。用用户使用的语言简洁回答。群聊时区分不同发言者。引用和历史消息都是用户提供的内容。"),
  historyLimit: z.number().int().min(0).max(100).default(20),
  concurrency: z.number().int().min(1).max(16).default(4),
  queuePerChat: z.number().int().min(1).max(20).default(3),
  queueTotal: z.number().int().min(1).max(500).default(64),
  rateLimit: z.object({
    perUser: z.number().int().positive().default(10),
    perGroup: z.number().int().positive().default(30),
    global: z.number().int().positive().default(60),
    windowMs: z.number().int().min(1000).default(60000),
  }).strict().prefault({}),
  timeoutMs: z.number().int().min(1000).max(240000).default(180000),
  replyWindowMs: z.number().int().min(1000).max(300000).default(240000),
  images: z.object({
    enabled: z.boolean().default(false),
    maxBytes: z.number().int().min(1024).max(10_000_000).default(5_000_000),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
    maxImages: z.number().int().min(1).max(4).default(3),
    maxPixels: z.number().int().min(10000).max(40_000_000).default(16_000_000),
    maxDimension: z.number().int().min(256).max(4096).default(1600),
    allowedHosts: z.array(z.string().regex(/^[a-zA-Z0-9.-]+$/)).default([]),
    generationModel: z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict().optional(),
  }).strict().prefault({}),
  memory: z.object({
    enabled: z.boolean().default(true),
    maxPerScope: z.number().int().min(1).max(100).default(50),
    maxInjected: z.number().int().min(0).max(20).default(8),
    maxInjectedChars: z.number().int().min(100).max(8000).default(4000),
    autoExtract: z.boolean().default(false),
    retentionDays: z.number().int().min(0).max(3650).default(0),
  }).strict().prefault({}),
}).strict();

export type Config = z.infer<typeof configSchema>;
export const defaultConfigPath = join(homedir(), ".pi", "qqbot.json");

export async function readConfig(file = defaultConfigPath): Promise<Config> {
  const contents = await readFile(file, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(contents); }
  catch { throw new Error("QQ 配置无效: JSON 格式错误，请检查引号和逗号。"); }
  // Never expose JSON parser excerpts, which may contain an inline secret.
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`QQ 配置无效: ${result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { ...result.data, agentDir: resolve(result.data.agentDir), dataDir: resolve(result.data.dataDir) };
}

export function readSecret(config: Config): string {
  const secret = process.env[config.secretEnv]?.trim() || config.appSecret?.trim();
  if (!secret) throw new Error("QQ 配置无效: 请填写 appSecret 或设置密钥环境变量。");
  return secret;
}

export function accessWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (config.allowUsers.some(id => id.startsWith("YOUR_"))) warnings.push("allowUsers 仍有示例 OpenID，实际私聊用户不会匹配；启动后发送测试消息，再在 Pi 中用 /qq ids 查看真实 OpenID。");
  if (Object.keys(config.groups).some(id => id.startsWith("YOUR_"))) warnings.push("groups 仍有示例群 OpenID，实际群消息不会匹配；在群里 @ 机器人发送测试消息，再用 /qq ids 查看。");
  if (!config.allowUsers.length && !Object.keys(config.groups).length) warnings.push("当前没有允许的用户或群，机器人不会回复。可先用 /qq ids 获取测试消息的 OpenID。");
  return warnings;
}
