# pi-qq

通过 QQ 官方机器人接入 Pi 的文本聊天扩展，支持 C2C 私聊和群聊。基于 `@tencent-connect/qqbot-nodejs@1.0.5` 和 `@earendil-works/pi-coding-agent@1.4.0`（适配时 npm 最新稳定版），要求 Node.js **22.19.0 或更高版本**。

这是可运行的第一版：已通过离线测试及本地模拟模型集成测试，尚未使用真实 QQ 凭据联调。完整选型依据见 [技术路线](docs/technical-route.md)。

## 安装与配置

其他电脑先准备 Git、GitHub CLI（`gh`）、Node.js 22.19+ 和 Pi 1.4.x，并配置好该电脑上的 Pi 模型认证。如果尚未安装 Pi，可以执行 `npm install -g @earendil-works/pi-coding-agent@1.4.0`。

仓库为私有仓库，需要使用 `iawnix` 或具有仓库访问权限的 GitHub 账号登录。以下示例使用 Bash：

```bash
gh auth login
gh repo clone iawnix/pi-qq
cd pi-qq
npm ci
npm run build
cp qqbot.example.json qqbot.json
```

编辑 `qqbot.json`：填写机器人的 AppID、Pi 模型的 provider/id、允许的用户及群。`agentDir` 默认 `~/.pi/agent`，复用其中的模型配置和认证；可指定绝对路径使用另一套配置。`dataDir` 默认 `~/.pi/qqbot`。显式填写路径时请使用绝对路径，JSON 中的 `~` 不会展开。

这里使用 QQ 开放平台机器人账号，不是个人 QQ 号登录。需要开通相应 C2C/群消息权限，并满足平台的测试成员或发布要求。

配置中的身份值来自 QQ 平台事件：

| 配置 | 应填写的标识 |
|---|---|
| `allowUsers` | 私聊事件 `author.user_openid` |
| `groups` 的键 | 群事件 `group_openid` |
| 群 `admins` | 该群事件 `author.member_openid` |

这些值不是 QQ 号码；私聊 OpenID 与群成员 OpenID 不保证相同。可从平台调试事件获取。第一版不包含扫码绑定和自动配对入口。空白名单默认不处理任何消息；加入群白名单即允许该群所有成员触发聊天。

在启动服务的同一 shell 设置 AppSecret 和配置位置。例如 Bash 下可隐藏输入，避免密钥进入命令历史：

```bash
read -rsp 'QQ AppSecret: ' QQBOT_APP_SECRET
export QQBOT_APP_SECRET
export PI_QQ_CONFIG="$PWD/qqbot.json"
node dist/cli.js check
```

`check` 检查配置、环境变量及模型注册情况，不连接 QQ、不调用模型，也不验证凭据有效性。仅通过用户自定义 Pi 扩展注册的模型不会加载，需使用内置模型或 `models.json` 中的模型。

## 两种运行方式

**独立进程**适合常驻部署：

```bash
node dist/cli.js start
```

也可直接运行 `npm start -- start --config /绝对路径/qqbot.json`。Ctrl+C 或 SIGTERM 会停止网关、取消请求并等待会话退出。

**Pi 扩展**适合在交互式 Pi 中管理：

```bash
pi -e ./src/extension.ts
```

Pi 内执行 `/qq start`、`/qq status`、`/qq stop`。扩展加载时不自动连接；退出 Pi 时清理连接。持久安装可在项目目录执行 `pi install "$PWD"`，随后重启 Pi；本地路径安装后请保留项目目录。每次启动 Pi 都需继承 `QQBOT_APP_SECRET` 和 `PI_QQ_CONFIG` 环境变量，或将配置放在默认位置 `~/.pi/qqbot.json`。

更新时先 `/qq stop` 并退出 Pi，在项目目录执行 `git pull --ff-only`、`npm ci`、`npm run build`，随后重新启动 Pi。真实配置、密钥、聊天数据和 node_modules 不提交到仓库，每台电脑单独配置。

当前测试在 Linux 上完成；Windows/macOS 尚未实机验证。同一 AppID 请只在一台电脑运行。

同一操作系统用户下，同一 AppID 只允许一个实例运行。实例锁位于 `~/.pi/qqbot-locks`，与配置的数据目录无关；不能在两种入口同时运行同一机器人。跨主机部署需自行确保单实例。

## 聊天行为

- 私聊用户各自拥有持久会话；同一群共享会话，保留发言者标识；机器人、群、私聊之间相互隔离。
- 群默认只有 @ 机器人时回答。`requireMention: false` 会处理平台实际推送的非 @ 消息，但不会增加机器人平台权限。
- 对于要求 @ 的群，暂存最近 `historyLimit` 条已推送的非触发消息，供下一次提问使用；未触发历史仅在内存中，进程重启后丢失。
- 同一聊天串行处理，不同聊天最多并行 4 个；每聊天最多等待 3 个任务，总共最多等待 64 个任务。超出队列会提示繁忙。
- 模型请求默认按固定时间窗口限制：每聊天内每用户 10 次/分钟、每群 30 次/分钟、全局 60 次/分钟。超限静默丢弃并记录 `rate_limited`；控制命令仍可使用。
- `/help` 显示帮助；`/stop` 取消自己的正在处理和排队请求；群管理员可取消整个群的请求。
- `/reset` 排队开启新会话。私聊用户可重置自己的会话，群内仅配置的管理员可重置；旧会话文件保留，不等同于删除历史。
- 群里的命令同样遵守 @ 门控，例如 `@机器人 /reset`。
- 首版只接收文本，只返回最终纯文本；引用内容只取平台提供的文本，不下载附件。长回复最多拆成 3 条，每条最多 4000 个 Unicode 码点；实际可发送长度和条数由平台权限决定。

远程聊天运行独立 Pi 会话，不加载本机的扩展、技能、提示模板、AGENTS.md、SYSTEM.md 或编程工具。默认不开放文件读取、写入和 shell。QQ 历史会发送给所配置的模型，并以 Pi 会话格式保存在 `dataDir/sessions`。

## 生命周期和限制

模型处理超时默认 180 秒；请求排队或回复时，超过 240 秒的原始消息不再处理/发送。240 秒是本应用的保守预算，**不是对 QQ 平台回复时限的保证**。回复始终携带原始 `msg_id`，失败或过期时不会自动改为主动消息。

取消会等待底层 Pi 请求真正结束后才释放会话锁，避免并发写同一会话。因此网络库退出缓慢时，停止服务也可能等待。断线重连最多尝试 20 次，耗尽后服务进入 `failed`；独立 CLI 返回非零退出码，可交给进程管理器重启。

WebSocket Resume 状态、Pi 对话文件、内存中的群历史分别管理。去重是内存 TTL 去重，不能保证崩溃重启后的恰好一次处理；发送失败时模型答案可能已经写入会话，但 QQ 用户尚未收到。首版不实现持久收件箱、主动推送、原生流式、媒体处理或跨主机协调。

诊断输出仅包含 `ready`、`gateway_failed`、`request_failed` 等状态代码，不输出密钥、消息正文或原始 HTTP 错误。若出现 `gateway_failed`，核对 AppID/密钥、平台权限、网络及重复实例；若出现 `request_failed`，核对模型认证和模型配置。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm audit
```

测试使用假网关和本地 HTTP 模型服务，不访问 QQ 或真实模型服务。覆盖白名单、@ 门控、身份隔离、群历史快照、取消/超时、队列边界、命令权限、实例锁、Pi SDK 历史恢复与重置，以及 Pi 原生扩展加载。

开发依赖和锁文件固定 Pi 1.4.0，扩展声明兼容 `~1.4.0`（1.4 系列补丁版）。已验证新版 SDK 的会话恢复、重置和原生扩展加载，并验证旧会话记录的 read/bash 工具不会重新启用。使用扩展入口时，宿主 Pi 也应为 1.4 系列；本项目安装依赖不会更新宿主 Pi。

Pi 的间接依赖 Undici 继续覆盖为 8.12.2，以修复安装时审计发现的问题。此覆盖只对本项目安装有效，不会修改用户独立安装的 Pi。升级 Pi 或 QQ SDK 后需重新运行这些检查。
