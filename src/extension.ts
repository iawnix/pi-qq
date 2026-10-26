import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessWarnings, readConfig } from "./config.js";
import { QQService } from "./service.js";
import { PiRunner } from "./agent.js";
import { UserError } from "./content.js";
import { hostQQTools } from "./qq-tools.js";

export default function qqExtension(pi: ExtensionAPI): void {
  let service: QQService | undefined;
  let starting: Promise<QQService> | undefined;
  let controller: AbortController | undefined;
  const requireService = () => {
    if (!service || service.status !== "ready") throw new UserError("QQ 尚未就绪，请先 /qq start 并等待 ready。");
    return service;
  };
  for (const tool of hostQQTools({ listGroups: () => requireService().listGroups(),
    sendGroup: (id, text, signal) => requireService().sendGroup(id, text, signal) })) pi.registerTool(tool);

  const stop = async () => {
    controller?.abort();
    const current = service ?? await starting?.catch(() => undefined);
    await current?.stop();
    service = undefined;
  };

  pi.registerCommand("qq", {
    description: "QQ 聊天：/qq start | stop | status | ids | groups | send 群OpenID 正文 | memories",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "groups") {
        try {
          const groups = requireService().listGroups();
          ctx.ui.notify(groups.length ? groups.map(g => `${g.name ?? "群"} ${g.groupId}\n回复：${g.replyMode}；主动发送：${g.allowProactive ? "允许" : "关闭"}；已收到 @ ${g.received.mentioned} 条、非 @ ${g.received.ordinary} 条`).join("\n\n") : "尚未配置群。", "info");
        } catch (error) { ctx.ui.notify(error instanceof UserError ? error.message : "群状态读取失败。", "warning"); }
        return;
      }
      if (command === "send" || command.startsWith("send ")) {
        const match = /^send\s+(\S+)\s+([\s\S]+)$/.exec(command);
        if (!match) { ctx.ui.notify("用法：/qq send 群OpenID 消息正文", "warning"); return; }
        try { const id = await requireService().sendGroup(match[1]!, match[2]!); ctx.ui.notify(`已发送，消息编号：${id}`, "info"); }
        catch (error) { ctx.ui.notify(error instanceof UserError ? error.message : "发送未确认成功，请检查群内结果及连接状态。", "warning"); }
        return;
      }
      if (command === "memories" || command.startsWith("memories ")) {
        if (!service) { ctx.ui.notify("请先 /qq start。", "warning"); return; }
        const [, action, id, ...extra] = command.split(/\s+/);
        if (extra.length) { ctx.ui.notify("用法：/qq memories [accept|reject 编号]", "warning"); return; }
        try { ctx.ui.notify(await service.manageMemories(action, id), "info"); }
        catch (error) { ctx.ui.notify(error instanceof UserError ? error.message : "记忆操作失败。", "warning"); }
        return;
      }
      if (command === "status") {
        ctx.ui.notify(`QQ: ${starting ? "starting" : service?.status ?? "stopped"}；本次服务已收到 ${service?.diagnostics().received ?? 0} 条消息。/qq ids 查看用户与群 OpenID，/qq groups 查看全量群消息接收和回复模式。`, "info");
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
        ctx.ui.notify("用法：/qq start | stop | status | ids | groups | send 群OpenID 正文 | memories", "warning");
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
