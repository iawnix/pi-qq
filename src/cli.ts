#!/usr/bin/env node
import { PiRunner } from "./agent.js";
import { defaultConfigPath, readConfig, readSecret } from "./config.js";
import { QQService } from "./service.js";

const usage = `pi-qq start|check [--config <文件>]

start  启动 QQ 文本聊天服务
check  检查配置、密钥环境变量和本地 Pi 模型目录（不连接 QQ 或调用模型）

默认配置：${defaultConfigPath}
也可设置 PI_QQ_CONFIG。Pi 内使用 /qq start|stop|status。`;

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) { console.log(usage); return; }
  if (!["start", "check"].includes(command) || (args.length && (args.length !== 2 || args[0] !== "--config"))) {
    console.error(usage); process.exitCode = 1; return;
  }
  const config = await readConfig(args[1] ?? process.env.PI_QQ_CONFIG);
  readSecret(config);
  if (command === "check") {
    await PiRunner.create(config);
    console.log(`配置有效；密钥变量已设置；模型已注册。允许 ${config.allowUsers.length} 个私聊用户、${Object.keys(config.groups).length} 个群。尚未验证 QQ 权限和模型凭据。`);
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const service = await QQService.start(config, code => console.error(`[pi-qq] ${code}`), { signal: controller.signal });
    await service.done;
    if (service.status === "failed") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(error => {
  // Initialization errors contain local configuration diagnostics; never print SDK HTTP bodies.
  const message = error instanceof Error ? error.message : "未知错误";
  const safe = message.startsWith("请设置环境变量") || message.startsWith("QQ 配置无效") ||
    message.startsWith("无法获取机器人实例锁") || message.startsWith("配置中的 Pi 模型不存在");
  console.error(safe ? message : "启动失败：请检查配置文件、Pi 模型配置及目录权限。");
  process.exitCode = 1;
});
