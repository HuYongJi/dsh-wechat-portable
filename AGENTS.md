# AGENTS.md

面向在本仓库中工作的 AI 编码智能体 / 开发者的项目约定。

## 项目简介

DSH（DeepSeek Harness）微信桥接插件。通过 iLink Bot 微信协议层把个人微信消息转发给本机 DSH Agent，并把 DSH 回复批量推回微信。三端通用（Windows / macOS / Linux）。

## 目录结构

- `src/index.ts`：DSH Host 插件，内部 HTTP+SSE API、Agent 生命周期、守护进程管理、模型工具。
- `src/bridge/`：微信协议层 + 独立守护进程（daemon）。
- `src/bridge/wechat/`：iLink Bot 协议、登录、媒体收发、监控、发送。
- `src/client/`：原生 Remote 管理面板（`settings.section` 槽位）。
- `src/portable/`：私有目录与普通配置迁移 CLI。
- `scripts/build.mjs`：跨平台构建 Host/Client 到 `lib/`。不使用旧 Bash 构建脚本。
- `docs/`：方向对照与可行性方案。

## 迁移版集成契约

- 独立包名：`dsh-wechat-portable`，仅声明经过测试的 DSH 版本；不使用版本豁免。
- 桌面管理使用原生 Typert Remote：namespace `wechatPortableControl`，方法 `request(action: string, payloadJson: string): Promise<string>`。Host 在 `src/host/control.ts` 导出严格描述符，Client 显式 `$mount` 对应贡献；浏览器专用 HTTP 路由不是桌面 IPC 的替代品。
- 私密状态按 profile 隔离；普通配置导出只走正向字段白名单，不迁移账号、token、日志、会话、绝对路径或权限。
- 仅单用户 owner 可接入；权限审批必须携带请求 nonce（`/yes <id>` 或 `/no <id>`）。
- 跨平台构建使用 Node 脚本，不要求 Bash 或开发者本机 DSH 源码路径。

## 常用命令

```bash
npm install
npm run typecheck
npm run build
npm run build:client
```

## 约定

- 使用 TypeScript 严格模式；源码在 `src/`，构建产物 `lib/` 不入库。
- 微信消息推送必须批量发送（阈值 + 定时器），不能每个 chunk 都发一条微信消息。
- 程序化创建 DSH Agent 时必须显式传入 provider/model（读取 `ctx.agentDefaultModel.currentSelection()`）。
- 不要提交本地账号、token、密钥、日志或真实聊天记录。
