# GitHub Release 分发指南

## 分发约定

使用 **GitHub Release 上预编译 `.tgz` 附件的下载直链**，不是让使用者粘贴仓库主页后临时编译。目标宿主仍为 DSH Desktop **0.2.0-rc.2**；不扩大兼容范围、不添加版本豁免。

源码仍不提交 `lib/`。只有本地打包成功不代表远程版本已发布，也不代表桌面/微信端到端验收已通过。维护者应先审核改动及文件清单，再明确决定是否发布。

## 1. 本地预检

需要 Node 22.19+ 和 pnpm **11.7.0**，建议与 Release runner 一样使用 Node 24.21.0。仓库只维护 pnpm 锁文件；不使用旧上游 npm 锁文件，也不自动发布到 npm。

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm run release:pack
```

`release:pack` 会依次执行完整构建和所有隔离回归、核对 exports/客户端注册标识，然后使用 `pnpm pack --config.ignore-scripts=true` 打包。这里禁用的是第二次重复的 prepack，不是跳过验证。子进程继承终端，打包 JSON 输出使用普通文件描述符，不依赖 Windows 沙箱禁止的捕获式管道。

默认输出到 `dist/release/`，必须是新目录或空目录；脚本不会删除或覆盖已有成果。再次检查可使用：

```text
pnpm run release:pack --out-dir dist/release-check-2
```

输出附件：

| 文件 | 用途 |
|---|---|
| `dsh-wechat-portable-版本号.tgz` | DSH 可直接安装的预编译包 |
| `SHA256SUMS.txt` | 上述安装包的 SHA-256 |
| `INSTALL-URL.txt` | 对应 GitHub Release 发布后可用的固定版本链接 |
| `RELEASE-NOTES.md` | 带链接、校验和、安装/升级步骤及限制的发布正文 |
| `PACKAGE-FILES.txt` | pnpm 实际打包清单 |
| `RELEASE-AUDIT.json` | 版本、宿主约束、附件摘要与打包检查记录 |

发布检查采用正向文件清单：编译后的 Host/Client、说明/许可、Portable 文档及已审核的二维码依赖。缺失入口、额外 SDK、运行状态、开发源码/测试、路径穿越、私密测试哨兵或个人绝对路径会阻止打包通过。清单来自 pnpm，内容扫描读取打包源文件；这不是独立的任意 tarball 安全扫描器，也不能替代代码审查。

## 2. 确定版本与 tag

1. 审核本次全部改动，确保只提交有意发布的内容。不要把未完成的其他任务、账号、日志或聊天记录打进版本。
2. 将 `package.json` 的版本、README、变更记录及面板版本文案保持一致。**已经分发过同一版本但内容有变化时，应增加版本号**，不要复用旧版本冒充同一安装包。
3. 在审核后的提交上创建与包版本完全一致的 `v版本号` tag。例如包版本为 `0.1.0-alpha.7` 时，tag 必须为 `v0.1.0-alpha.7`；不能只创建 tag 而不更新包版本。
4. 经仓库维护者确认后，推送提交及该 tag 到自己的 `origin`。不要使用 `git push --tags` 把继承的上游历史 tag 一并发布。

本地可以提前验证 tag/version 一致性。下面只是版本示例，须先把包版本实际更新为同一值：

```text
pnpm run release:pack --tag v0.1.0-alpha.7 --out-dir dist/alpha7-check
```

版本不符时脚本失败；它不会创建 tag、提交代码、推送仓库、上传附件或安装到个人 DSH profile。

## 3. GitHub 自动发布

[发布工作流](../../.github/workflows/publish.yml) 在推送 `v*` tag 时运行，也可在 Actions → **GitHub Release** 手动输入一个**已经存在**的 tag。手动运行会检出该 tag，而不是悄悄打包 main 的最新提交。

工作流分成两个 job：

- **build**：只读仓库权限；固定 Node/pnpm，按冻结锁文件安装依赖，不运行依赖生命周期脚本；执行 `release:pack`，只有全部通过才上传指定附件。
- **publish**：只有这个 job 具有 `contents: write`；不检出源码、不执行依赖或构建脚本，仅下载已验证附件并用 GitHub CLI 创建 Release。无需 npm token 或 OIDC 发布权限。

预览版本自动标记为 **Prerelease**，不会设置成 Latest。tag、包版本、附件名、下载链接必须一致。工作流使用 `--verify-tag`，不会替你创建缺失的 tag；不使用 `--clobber`，不会覆盖已有 Release 或同名附件。相同 tag 的并发发布串行执行。

如果构建阶段失败，修复后按正常版本审查流程处理。若失败发生在已创建 Release 之后，先检查远程 Release 与附件实际状态；不要盲目重跑、强推 tag 或覆盖已分发的字节。

[普通 CI](../../.github/workflows/ci.yml) 同样执行打包验证，覆盖 Linux Node 22.19/24.21 和 Windows Node 24.21；这只是计划运行的 CI 矩阵，不等于这些平台的真实 DSH/微信验收已经通过。

## 4. 把安装链接交给使用者

发布成功后，Release 正文和 `INSTALL-URL.txt` 都包含这种固定版本地址：

```text
https://github.com/HuYongJi/dsh-wechat-portable/releases/download/v0.1.0-alpha.7/dsh-wechat-portable-0.1.0-alpha.7.tgz
```

这只是当前版本地址格式示例，**附件实际发布之前会返回 404**。以成功发布的 Release 中提供的地址为准；不要拼接 `releases/latest`，因为 Alpha 属于预发布。Fork 发布时，工作流使用实际 `GITHUB_REPOSITORY` 生成链接；本地打包可通过 `--repository OWNER/REPO` 明确指定目标仓库。

使用者在 **DSH → 插件 → 添加插件 → 包名或地址** 中粘贴 `.tgz` 链接即可走预编译安装。不要复制 GitHub 仓库主页、Release 展示页面或自动生成的 Source code ZIP。

发布后仍需人工确认：

- 在目标设备上能访问附件及校验和，下载文件的 SHA-256 与 Release 一致。
- 在测试 DSH 0.2.0-rc.2 中，从插件页粘贴该真实 HTTPS 下载链接并安装；不添加版本豁免。
- 启用并完整重启宿主，设置面板/扫码/手动启动正常；其余真实微信验收按 [验证记录](VALIDATION.md) 执行。

若目标网络无法访问 GitHub，下载并校验 `.tgz` 后使用本地绝对路径安装；更换 npm 镜像不代理 GitHub，不能通过关闭 TLS 校验解决。请勿将任何微信授权、个人 profile 或聊天记录作为 Release 附件。
