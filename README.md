# pi-qq

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.19.0-green.svg)](https://nodejs.org/)
[![Pi](https://img.shields.io/badge/Pi-1.4.x-blue.svg)](https://github.com/earendil-works/pi)

将 [Pi](https://github.com/earendil-works/pi) 接入 QQ 私聊和群聊的 TypeScript 扩展，也可作为独立服务运行。

通过 QQ 开放平台机器人收发消息，复用 Pi 的模型配置与认证，维护独立、持久的对话、用户画像和长期记忆，支持图片理解与图片回复。基于 [qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs) 构建。

> 项目处于早期开发阶段。已通过本地测试和模拟模型集成测试，已完成 QQ 私聊和群聊文本回复联调，媒体及本机工具的 QQ 端联调仍待验证。当前在 Linux 上验证，Windows/macOS 尚未实机测试。

## 功能

- **私聊与群聊**：私聊用户独立会话；群聊可共享上下文或按成员隔离，默认 @ 机器人触发。
- **群参与和主动发送**：接收平台推送的全量群消息，可选择性接话；Pi 命令和工具可向授权群主动发文字。需在 QQ 群设置中开放相应权限，见[配置说明](docs/configuration.md#群全量消息与选择性接话)。
- **跨场景连续聊天**：通过本机 `identityLinks` 明确绑定同一人的私聊与群成员身份，共享完整会话、记忆和关系；见[配置说明](docs/configuration.md#同一人的私聊与群聊完整同步)。
- **画像与长期记忆**：SQLite 持久化，跨对话重置保留；支持查看、删除、停用，以及需要确认的自动记忆候选。
- **图片**：可选的图片理解、附件回传与图片生成；生成能力使用单独配置的 Pi 图片模型。
- **访问控制**：用户和群白名单，按群配置管理员。
- **会话管理**：历史持久化、重置对话、取消正在处理和排队的请求。
- **并发控制**：同一聊天串行处理，不同聊天并发；支持队列上限、限流和超时。
- **独立运行环境**：聊天会话不自动加载个人扩展、技能或工作区提示；文件与终端工具默认关闭，可按私聊用户和群授权。
- **角色成长**：可选身份卡、逐级确认的关系阶段、有来源的长期经历及群内差异化感受；见 [Friend 使用指南](docs/friend.md)。
- **两种入口**：Pi 内的 `/qq` 命令，以及独立 CLI。

本机工具、图片功能和自动记忆提取默认关闭；手动记忆默认可用。扫码绑定、原生流式回复、语音及视频处理尚未实现。

## 快速开始

需要 Node.js **22.19+**、Git、**Pi 1.4.x**，以及已开通所需消息权限的 QQ 开放平台机器人。请先在 Pi 中配置可用的模型与认证。

### 1. 获取源码

```bash
git clone https://github.com/iawnix/pi-qq.git
cd pi-qq
npm ci
npm run build
cp qqbot.example.json qqbot.json
```

尚未发布到 npm，当前使用源码安装。以下终端示例使用 Bash。

### 2. 配置机器人

编辑 `qqbot.json`，填写 `appId`、`appSecret`，以及允许的用户和群。作为 Pi 扩展使用时，默认跟随 Pi 当前模型和认证，不需要填写 `model`。QQ 的 OpenID 不是 QQ 号码，私聊用户与群成员的标识也不通用。详见 [配置文档](docs/configuration.md)。

`appSecret` 直接填写机器人后台的 AppSecret，例如：

```json
{
  "appId": "你的AppID",
  "appSecret": "你的AppSecret",
  "allowUsers": ["你的私聊OpenID"]
}
```

在项目目录检查配置：

```bash
node dist/cli.js check --config ./qqbot.json
```

`check` 验证本地配置和 AppSecret；明确填写 `model` 时还会检查本地模型注册情况。不填写时，模型在 Pi 内启动时确定；终端检查不会尝试猜测正在运行的 Pi 模型。检查不调用 QQ 或模型接口。也可将 `appSecret` 留空，使用 `secretEnv` 指定的环境变量（默认 `QQBOT_APP_SECRET`）；两者都有值时环境变量优先。真实 `qqbot.json` 已被 Git 忽略，请勿把密钥填写到会提交的示例文件中。

还不知道 OpenID 时，可以先将 `allowUsers` 设为 `[]`、`groups` 设为 `{}`。启动后用自己的 QQ 私聊机器人（或在测试群里 @ 它），再在 **Pi 中**执行 `/qq ids`。将看到的真实 ID 填入配置，然后 `/qq stop`、`/qq start` 重启服务。未加入白名单前不会回复；不要保留示例里的 `YOUR_...` 字符串。

### 3. 启动

**作为 Pi 扩展**：

```bash
pi install "$PWD"
export PI_QQ_CONFIG="$PWD/qqbot.json"
pi
```

在 Pi 中用 `/model` 选择模型，再执行 `/qq start`。QQ 默认跟随当前选择，切换模型对后续开始处理的请求生效；正在处理的请求使用原模型。也可用 `pi -e ./src/extension.ts` 临时加载扩展。扩展不会自动连接 QQ，退出 Pi 时会停止服务。

**作为独立服务**：

独立进程没有宿主 Pi 会话；省略 `model` 时在启动时读取 Pi 保存的默认模型，也可在 JSON 中固定指定。模型及认证需在同一台电脑、同一用户下配置；详见[模型选择](docs/configuration.md#模型选择)。

```bash
node dist/cli.js start --config ./qqbot.json
```

同一 AppID 只在一台电脑上运行一个实例。使用本地路径安装后，请保留源码目录；后续启动继续指定该配置文件；Pi 扩展需设置 `PI_QQ_CONFIG`，或将配置放到默认的 `~/.pi/qqbot.json`。

## 本机文件与终端

需要通过 QQ 操作电脑时，在 `localTools` 中启用指定的 Pi 内置工具，并单独授权私聊用户或群。支持文件读取、写入、编辑、搜索与终端命令；群授权对该群所有成员生效，和 `admins` 无关。配置示例与权限说明见[本机工具](docs/configuration.md#本机工具)。

工具以运行 Pi 的系统账号执行；`cwd` 只是默认工作目录，不是沙箱。未绑定身份的聊天上下文仍隔离，但工具访问同一台电脑。

## 命令

| 位置 | 命令 | 功能 |
|---|---|---|
| Pi | `/qq start` | 启动 QQ 服务 |
| Pi | `/qq status` | 查看服务状态及收到的消息数 |
| Pi | `/qq ids` | 查看最近收到的私聊用户、群和群成员 OpenID |
| Pi | `/qq groups` | 查看群回复模式、主动发送权限和 @ / 非 @ 接收统计 |
| Pi | `/qq send 群OpenID 正文` | 向授权群主动发送文字 |
| Pi | `/qq memories` | 本地查看并管理自动提取的事实候选 |
| Pi | `/qq stop` | 停止服务并取消请求 |
| QQ | `/help` | 查看聊天帮助 |
| QQ | `/tools` | 查看当前聊天的本机工具权限与工作目录 |
| QQ | `/stop` | 取消自己的请求；共享群管理员可停止当前群会话 |
| QQ | `/reset` | 开启新对话，保留长期记忆；共享群仅管理员可用 |
| QQ | `/stop all` / `/reset all` | 群管理员停止或重置群内独立会话；跳过跨场景绑定会话 |
| QQ | `/remember 内容` | 明确保存一条长期记忆 |
| QQ | `/profile` / `/profile 字段=值` | 查看或设置画像，如 `replyStyle=简洁` |
| QQ | `/memory [页码]` | 查看已确认的记忆 |
| QQ | `/memory pending [页码]` | 查看自动提取的候选 |
| QQ | `/memory accept 编号` / `/memory reject 编号` | 确认或删除候选 |
| QQ | `/memory replace 旧编号 新候选编号` | 用已核对的新事实替换旧事实 |
| QQ | `/关系 [下一阶段\|上一阶段]` | 角色模式中查看或逐级确认关系 |
| QQ | `/经历 [页码]` / `/经历 删除 编号` | 查看或删除自己的角色经历 |
| QQ | `/重新认识 确认` | 清理自己的记忆与经历，关系回到初识 |
| QQ | `/memory on` / `/memory off` | 启用或停用当前作用域记忆，并清理旧对话 |
| QQ | `/forget 编号` / `/forget all` | 删除指定或全部记忆，同时清理当前作用域所有旧对话 |
| QQ | `/image echo` + 图片附件 | 处理后回传图片 |
| QQ | `/image 图片描述` | 生成一张图片；可附带图片请求编辑 |

群里的命令同样遵守 @ 规则，例如 `@机器人 /reset`。共享群的记忆和画像供全群使用，仅配置的管理员可修改。成员隔离模式下，每个人可管理自己的会话和记忆，但机器人发到群里的回复仍对群成员可见。

`/reset` 保留旧历史文件；`/forget` 才会清理当前作用域的本地历史和指定记忆。普通发送图片用于提问，需先开启 `images.enabled` 并在 Pi 中选择支持视觉输入的聊天模型；生成图片还需配置 `images.generationModel`。完整示例见[图片配置](docs/configuration.md#图片理解与回复)。

## 文档

- [配置与运行](docs/configuration.md)：OpenID、白名单、模型、存储、限流及故障排查。
- [技术路线](docs/technical-route.md)：SDK 选型、架构、平台边界和后续计划。
- [贡献指南](CONTRIBUTING.md)：本地检查与问题反馈。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

测试使用假网关和本地 HTTP 模型服务，不需要 QQ 或模型凭据。覆盖会话和记忆隔离、恢复与删除、权限、队列、取消、图片下载策略，以及真实 Pi SDK 的视觉输入、图片生成、记忆候选提取和原生扩展加载。

## 许可证与致谢

本项目采用 [MIT License](LICENSE)。第三方依赖保留各自的版权和许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

感谢 [Pi](https://github.com/earendil-works/pi) 与 [qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs) 提供基础能力；[openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot) 为通道适配设计提供参考。

本项目是独立的第三方项目，不隶属于腾讯或 Pi 项目，也不代表其官方支持。使用 QQ 开放平台及模型服务须遵守相应服务条款；本项目的开源许可证不授予平台访问权限或商标使用权。
