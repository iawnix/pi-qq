import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.js";
import { QQService } from "./service.js";
import { PiRunner } from "./agent.js";
import { UserError } from "./content.js";

export default function qqExtension(pi: ExtensionAPI): void {
  let service: QQService | undefined;
  let starting: Promise<QQService> | undefined;
  let controller: AbortController | undefined;

  const stop = async () => {
    controller?.abort();
    const current = service ?? await starting?.catch(() => undefined);
    await current?.stop();
    service = undefined;
  };

  pi.registerCommand("qq", {
    description: "QQ 聊天：/qq start | stop | status",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "status") {
        ctx.ui.notify(`QQ: ${starting ? "starting" : service?.status ?? "stopped"}`, "info");
        return;
      }
      if (command === "stop") {
        await stop();
        ctx.ui.notify("QQ 已停止", "info");
        return;
      }
      if (command !== "start") {
        ctx.ui.notify("用法：/qq start | stop | status", "warning");
        return;
      }
      if (starting || (service && service.status !== "stopped" && service.status !== "failed")) {
        ctx.ui.notify("QQ 已启动或正在启动", "info");
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      starting = readConfig(process.env.PI_QQ_CONFIG).then(config => QQService.start(config,
        code => ctx.ui.notify(`QQ: ${code}`, code.endsWith("failed") ? "error" : "info"), {
          signal, runner: PiRunner.fromHost(config, () => ({ model: ctx.model, modelRegistry: ctx.modelRegistry })),
        }));
      try {
        service = await starting;
        ctx.ui.notify(`QQ: ${service.status}，使用 /qq status 查看状态`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof UserError ? error.message : "QQ 启动失败，请用 pi-qq check 检查配置，并确认没有重复启动。", "error");
      } finally { starting = undefined; }
    },
  });
  pi.on("session_shutdown", stop);
}
