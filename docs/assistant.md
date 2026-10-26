# AI 助手与 systemd 用户服务

QQ 服务可直接调用 Pi SDK，无需运行交互式 Pi 或输入 `/qq start`。systemd 只负责进程生命周期，每个人的会话仍独立，显式 `identityLinks` 仍共享本人绑定场景的数据。

## 目录与配置

沿用 [Friend 目录布局](friend.md)：程序在 `~/Friend/.app/pi-qq`，配置与人格在 `~/Friend`，认证在 `.runtime/pi-agent`，QQ 会话和数据库在 `.runtime/qq`。不要改动现有 `character.id`、`dataDir` 或身份绑定来切换人格，否则会进入另一份数据命名空间。

把 [SOUL.example.md](../examples/assistant/SOUL.example.md)、[SYSTEM.example.md](../examples/assistant/SYSTEM.example.md) 复制成自己的 SOUL.md、SYSTEM.md。示例为叶晚柠：具有中原小镇意象与“机械飞升”创作背景的原生 AI 助手；背景并非现实人类经历。

在已有 qqbot.json 中合并以下字段，保留原来的密钥、白名单、工具授权与身份绑定：

```json
{
  "agentDir": "/home/你的用户名/Friend/.runtime/pi-agent",
  "dataDir": "/home/你的用户名/Friend/.runtime/qq",
  "character": {
    "id": "保持你原有的ID",
    "mode": "assistant",
    "soulFile": "SOUL.md",
    "rulesFile": "SYSTEM.md",
    "evolution": true,
    "shareGroupExperiences": true
  },
  "context": {
    "maxTokens": 24000,
    "keepRecentTokens": 6000,
    "archiveAfterDays": 7,
    "archiveAfterBytes": 2000000,
    "archiveRetentionDays": 90
  }
}
```

群仍使用 `sessionScope: "member"`。助手模式保留 `/remember`、`/memory`、`/profile`、`/经历`、`/forget`、`/reset` 和工具操作；不提供关系推进或恋爱评分。旧历史中的养成规则不再执行。

不填 `model` 时，独立服务读取 `agentDir/settings.json` 保存的 Pi 默认 provider/model 和该目录下的认证、模型配置；不跟随其他终端里临时切换的模型。修改默认模型后重启服务。QQ 内部会话不加载个人扩展、技能或项目上下文文件。

## 安装用户服务

先构建程序；若机器人正在交互式 Pi 中运行，先 `/qq stop` 释放实例锁，不必退出 Pi。

```bash
cd ~/Friend/.app/pi-qq
npm ci
npm run build
node dist/cli.js check --config ~/Friend/qqbot.json
mkdir -p ~/.config/systemd/user
cp examples/systemd/pi-qq.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-qq.service
```

模板使用 `/usr/bin/node` 和 `~/Friend` 布局；使用不同 Node 安装位置或目录时，先修改 unit 中的绝对路径。若密钥只存在于交互式 shell 环境，需要改为受保护的配置文件或 systemd EnvironmentFile；服务不会自动继承当前 shell 的 export。不要将真实密钥写进公开 unit。

让服务在未登录时也运行，需要启用 lingering（可能需要系统管理员授权）：

```bash
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

使用 systemd 管理同一机器人后，不要同时在 Pi 中 `/qq start`。实例锁会拒绝第二个进程，避免重复回复或并发写入会话。

## 日常管理

```bash
systemctl --user status pi-qq.service --no-pager
journalctl --user -u pi-qq.service -n 50 --no-pager
systemctl --user restart pi-qq.service
systemctl --user stop pi-qq.service
```

日志中的 `ready` 表示 QQ 网关连接就绪，不代表模型或每个群的权限已经端到端验证。日志不输出完整消息或凭据。服务自动重启进程，但同一请求的回复不做无限重试。

关闭终端、退出 Pi 不影响服务。SOUL.md、SYSTEM.md 下一轮重新读取；qqbot.json 和程序修改后需要重启服务。Pi 中的 `/qq status` 等命令只管理该 Pi 进程内的服务；后台服务状态请用 systemctl 和日志查看。

要临时切回交互模式，先 `systemctl --user stop pi-qq.service`，再运行 `~/Friend/start-friend.sh` 并 `/qq start`；恢复后台前先 `/qq stop`。

## 上下文与历史

详细参数和保留期见 [上下文预算与归档](configuration.md#聊天上下文预算与历史归档)。预算控制进入模型的上下文；归档控制活动文件增长，两者不改变身份隔离。归档保留 90 天不是删除长期记忆，闲置身份的清理在下一次使用时执行。
