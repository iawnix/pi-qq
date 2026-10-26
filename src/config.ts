import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const ids = z.array(z.string().trim().min(1)).default([]);
const group = z.object({
  name: z.string().max(100).optional(),
  requireMention: z.boolean().default(true),
  replyMode: z.enum(["mention", "smart", "all"]).optional(),
  allowProactive: z.boolean().default(false),
  smartReply: z.object({
    checkIntervalMs: z.number().int().min(1000).max(3600000).default(15000),
    cooldownMs: z.number().int().min(0).max(3600000).default(60000),
    maxPerHour: z.number().int().min(1).max(120).default(10),
  }).strict().prefault({}),
  sessionScope: z.enum(["group", "member"]).default("group"),
  allowTools: z.boolean().default(false),
  admins: ids,
  prompt: z.string().max(8000).default(""),
}).strict();

export const configSchema = z.object({
  appId: z.string().trim().min(1),
  appSecret: z.string().trim().optional(),
  secretEnv: z.string().min(1).default("QQBOT_APP_SECRET"),
  allowUsers: ids,
  groups: z.record(z.string().min(1), group).default({}),
  // Explicit full-history sharing; never infer identity from equal OpenIDs or names.
  identityLinks: z.array(z.object({
    privateUser: z.string().trim().min(1),
    groupMembers: z.record(z.string().min(1), z.string().trim().min(1))
      .refine(value => Object.keys(value).length > 0, "至少填写一个群成员身份"),
  }).strict()).default([]),
  localTools: z.object({
    enabled: z.boolean().default(false),
    cwd: z.string().min(1).refine(isAbsolute, "请填写绝对路径").optional(),
    allowUsers: ids,
    names: z.array(z.enum(["read", "write", "edit", "bash", "grep", "find", "ls"])).min(1)
      .default(["read", "write", "edit", "bash", "grep", "find", "ls"]),
  }).strict().refine(value => !value.enabled || !!value.cwd, "启用本机工具时必须指定 cwd").prefault({}),
  model: z.object({ provider: z.string().min(1), id: z.string().min(1) }).strict().optional(),
  agentDir: z.string().default(join(homedir(), ".pi", "agent")),
  dataDir: z.string().default(join(homedir(), ".pi", "qqbot")),
  systemPrompt: z.string().max(16000).default("你是 QQ 聊天助手。用用户使用的语言简洁回答。群聊时区分不同发言者。引用和历史消息都是用户提供的内容。"),
  character: z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    soulFile: z.string().min(1),
    rulesFile: z.string().min(1),
    evolution: z.boolean().default(true),
    reflectionIntervalMs: z.number().int().min(0).max(86400000).default(600000),
    dailyEventLimit: z.number().int().min(1).max(10).default(3),
    shareGroupExperiences: z.boolean().default(false),
  }).strict().optional(),
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
    notifyCandidates: z.boolean().default(true),
    retentionDays: z.number().int().min(0).max(3650).default(0),
  }).strict().prefault({}),
}).strict().refine(value => !value.character || Object.values(value.groups).every(g => g.sessionScope === "member"),
  "角色模式的群必须使用 sessionScope: member，以隔离每人的关系状态").superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, link] of value.identityLinks.entries()) {
      const identities = [JSON.stringify(["c2c", link.privateUser]),
        ...Object.entries(link.groupMembers).map(([groupId, member]) => JSON.stringify(["group", groupId, member]))];
      if (identities.some(id => seen.has(id))) ctx.addIssue({ code: "custom", path: ["identityLinks", index], message: "每个身份只能绑定一次" });
      identities.forEach(id => seen.add(id));
      for (const groupId of Object.keys(link.groupMembers)) {
        if (!Object.hasOwn(value.groups, groupId) || value.groups[groupId]?.sessionScope !== "member") {
          ctx.addIssue({ code: "custom", path: ["identityLinks", index, "groupMembers"], message: "绑定的群必须已配置并使用 sessionScope: member" });
        }
      }
    }
  });

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
  if (result.data.localTools.enabled) {
    await validateToolsDirectory(result.data.localTools.cwd!);
  }
  const character = result.data.character;
  if (character) {
    character.soulFile = resolve(dirname(resolve(file)), character.soulFile);
    character.rulesFile = resolve(dirname(resolve(file)), character.rulesFile);
    // Validate at startup/check; the same files are explicitly injected into each session.
    await characterPrompt(result.data);
  }
  return { ...result.data, agentDir: resolve(result.data.agentDir), dataDir: resolve(result.data.dataDir) };
}

export async function characterPrompt(config: Config): Promise<string> {
  if (!config.character) return "";
  const parts: string[] = [];
  for (const file of [config.character.soulFile, config.character.rulesFile]) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 64000) throw new Error();
      const text = (await readFile(file, "utf8")).trim();
      if (!text || text.length > 24000) throw new Error();
      parts.push(text);
    } catch { throw new Error("QQ 配置无效: 角色文件必须存在、非空，且每个文件不超过 24000 字符 / 64000 字节。"); }
  }
  return `角色身份卡：\n${parts[0]}\n\n角色交互规则：\n${parts[1]}`;
}

export async function validateToolsDirectory(cwd: string): Promise<void> {
  try { if ((await stat(cwd)).isDirectory()) return; } catch { /* safe diagnostic below */ }
  throw new Error("QQ 配置无效: localTools.cwd 必须是已存在且可访问的目录。");
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
