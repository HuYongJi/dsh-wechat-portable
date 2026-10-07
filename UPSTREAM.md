# 来源与独立修改说明

本项目独立名称为 `dsh-wechat-portable`，初始版本 `0.1.0-alpha.1`。没有使用上游发布权限，也没有声称官方或上游背书。

- 上游：[lanbaolu/dsh-wechat-bridge](https://github.com/lanbaolu/dsh-wechat-bridge)
- 基线：[v0.9.1](https://github.com/lanbaolu/dsh-wechat-bridge/tree/v0.9.1)
- 提交：`555391e918104bdd65c4c5fd9c91dc4ff417a7f5`
- 原许可：MIT，原版权行完整保留在 LICENSE。
- 上游进一步参考了 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 的微信协议实现；不将协议归为本分支原创。

本分支的修改包括：DSH 0.2 SDK 适配、原生桌面管理 Remote、单用户约束、审批 nonce/取消清理、事件重放、会话 preset/权限保留、私有按 profile 存储、附件路径边界、白名单配置迁移、Node 跨平台构建、独立测试和安全分享打包。

协议层大部分代码仍来自上游。上游曾写明的真实微信/其他平台测试结果，不等同于本分支已经完成这些测试。本分支验证范围以 docs/portable/VALIDATION.md 为准。

运行时依赖 qrcode、qrcode-terminal 及其传递依赖保留各自随包附带的许可证。DSH SDK 为宿主提供的 peer；本发行包不是 DSH 桌面程序的再分发。
