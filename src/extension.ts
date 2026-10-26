import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessWarnings, readConfig } from "./config.js";
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
    description: "QQ 聊天：/qq start | stop | status | ids | memories",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "memories" || command.startsWith("memories ")) {
        if (!service) { ctx.ui.notify("请先 /qq start。", "warning"); return; }
        const [, action, id, ...extra] = command.split(/\s+/);
        if (extra.length) { ctx.ui.notify("用法：/qq memories [accept|reject 编号]", "warning"); return; }
        try { ctx.ui.notify(await service.manageMemories(action, id), "info"); }
        catch (error) { ctx.ui.notify(error instanceof UserError ? error.message : "记忆操作失败。", "warning"); }
        return;
      }
      if (command === "status") {
        ctx.ui.notify(`QQ: ${starting ? "starting" : service?.status ?? "stopped"}；本次服务已收到 ${service?.diagnostics().received ?? 0} 条消息。/qq ids 查看用户与群 OpenID。`, "info");
        return;
      }
      if (command === "ids") {
        const identities = service?.diagnostics().identities ?? [];
        if (!identities.length) {
          ctx.ui.notify("还没有收到用户消息。先执行 /qq start，再用 QQ 私聊机器人或在群里 @ 它发一条消息，然后重新执行 /qq ids。若一直收不到，请检查 QQ 平台测试成员、测试群及消息权限。", "info");
          return;
        }
        const rows = identities.map(item => item.scope === "c2c"
          ? `私聊 ${item.allowed ? "已在白名单" : "未在白名单"}\nallowUsers 中填写：${JSON.stringify(item.senderId)}`
          : `群聊 ${item.allowed ? "已在白名单" : "未在白名单"}\ngroups 的群键：${JSON.stringify(item.targetId)}\n本次发言成员 OpenID：${JSON.stringify(item.senderId)}`);
        ctx.ui.notify(`最近收到的身份（仅在 Pi 本地显示，不会自动授权）：\n\n${rows.join("\n\n")}\n\n确认是你的测试消息后填写 qqbot.json，再用 /qq stop、/qq start 重新加载配置。`, "info");
        return;
      }
      if (command === "stop") {
        await stop();
        ctx.ui.notify("QQ 已停止", "info");
        return;
      }
      if (command !== "start") {
        ctx.ui.notify("用法：/qq start | stop | status | ids | memories", "warning");
        return;
      }
      if (starting || (service && service.status !== "stopped" && service.status !== "failed")) {
        ctx.ui.notify("QQ 已启动或正在启动", "info");
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      starting = readConfig(process.env.PI_QQ_CONFIG).then(config => {
        for (const warning of accessWarnings(config)) ctx.ui.notify(warning, "warning");
        return QQService.start(config,
          code => ctx.ui.notify(`QQ: ${code}`, code.endsWith("failed") ? "error" : "info"), {
            signal, runner: PiRunner.fromHost(config, () => ({ model: ctx.model, modelRegistry: ctx.modelRegistry })),
          });
      });
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
