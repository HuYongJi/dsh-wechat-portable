# 贡献指南 / Contributing Guide

欢迎贡献！在提交 PR 前请阅读以下约定。

## 开发环境

- Node.js >= 22.19（Release runner 使用 24.21.0）
- pnpm 11.7.0，使用仓库提交的 pnpm 锁文件
- 可选：本地 DSH 0.2.0-rc.2 环境（用于真机联调）

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
pnpm run release:pack
```

`release:pack` 验证后生成本地 `dist/release/` 附件，不会发布到 GitHub 或 npm，也不会安装到个人 DSH。输出目录必须为空。维护者的 tag/Release 发布流程见 [发布指南](docs/portable/RELEASING.md)。

## 提交 PR

1. Fork 本仓库并创建功能分支（`feat/xxx`、`fix/xxx`）。
2. 修改代码，保持 TypeScript 严格模式通过。
3. 本地跑通 `verify` 与 `release:pack`，包含全部回归和打包入口检查；不要跳过失败测试。
4. 提交信息使用简洁的祈使句，例如 `fix: batch WeChat streaming replies`。
5. 创建 PR 时填写模板，说明改动和测试方式。

## 代码约定

- 源码在 `src/`，输出到 `lib/`（不提交 `lib/`）。
- 微信协议层在 `src/bridge/wechat/`，DSH Host 插件在 `src/index.ts`。
- 新增对外能力时同步更新 `README.md` 和 `docs/`。
- 不得提交任何账号、token、密钥、日志或真实聊天记录。
