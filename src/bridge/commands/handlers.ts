import type { CommandContext, CommandResult } from './router.js';
import type { DshProjectSession } from '../dsh-client.js';
import { loadConfig, saveConfig } from '../config.js';

import { isPlausibleUserId, addTrusted, removeTrusted, listTrusted } from '../trust.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateOutboundFile } from '../safe-files.js';

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /stop             停止当前对话并清空排队消息
  /yes <审批码>     一次性批准对应的权限请求（超时自动拒绝）
  /no <审批码>      拒绝对应的权限请求
  /new              创建并进入全新会话（保留旧会话）
  /sessions         查看会话列表（标记当前会话）
  /switch <序号|ID|项目名>  切换到已有会话
  /clear            清空当前上下文（不删除 DSH 历史）
  /reset            完全重置（包括工作目录等设置）
  /status           查看当前会话状态
  /history [数量]   查看对话记录（默认最近20条）
  /undo [数量]      撤销最近对话（默认1条）

文件：
  /send <路径>      发送本地文件（图片直接显示，其他文件作为附件）

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换模型
  /prompt [内容]    查看或设置系统提示词（全局生效）

兼容命令：
  /sessionlist、/projects  同 /sessions
  /session [序号|ID|off]  切换会话 / 查看当前 / 解除绑定

也可直接发送：
  新建会话 · 查看会话列表 · 切换会话 2 · 清空上下文
  当前会话 · 停止当前任务 · 会话帮助
仅整条消息匹配短语时执行；序号来自最近一次查看的列表。
新建、清空、切换会停止当前任务并丢弃排队消息。

其他：
  /version          查看版本信息

直接输入文字即可与 DSH 对话`;

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export async function handleClear(ctx: CommandContext): Promise<CommandResult> {
  try {
    await ctx.clearContext();
    return { reply: '✅ 上下文已清空，下次消息将开始新会话。工作目录和模型设置保留，DSH 历史会话未删除。', handled: true };
  } catch {
    return { reply: '⚠️ 清空上下文失败，请检查电脑端状态后重试。', handled: true };
  }
}

export async function handleNew(ctx: CommandContext): Promise<CommandResult> {
  try {
    const result = await ctx.createSession();
    if (result.ok === false) throw new Error('create refused');
    const id = typeof result.sessionId === 'string' ? `（${result.sessionId.slice(-8)}）` : '';
    return { reply: `✅ 已创建并进入新会话${id}。旧会话已保留，可用 /sessions 查看并切回。`, handled: true };
  } catch {
    return { reply: '⚠️ 新建会话失败，请检查电脑端模型与工作目录设置后重试。', handled: true };
  }
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ 工作目录已切换为: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model deepseek-v4-flash', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export async function handleReset(ctx: CommandContext): Promise<CommandResult> {
  try {
    await ctx.clearContext(true);
    return { reply: '✅ 上下文及会话设置已重置为桥接默认值，DSH 历史会话未删除。', handled: true };
  } catch {
    return { reply: '⚠️ 重置失败，请检查电脑端状态后重试。', handled: true };
  }
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `dsh-wechat-portable v${version}`, handled: true };
  } catch {
    return { reply: 'dsh-wechat-portable (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
}

export function handleSend(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /send <文件路径>\n例: /send ~/Documents/report.pdf\n     /send ./chart.png', handled: true };
  }

  try {
    const file = validateOutboundFile(args.replace(/^~/, homedir()), ctx.session.workingDirectory);
    return { handled: true, sendFile: file };
  } catch {
    return { handled: true, reply: '无法发送：仅允许当前工作目录内的普通文档、图片或 MP4（≤25 MiB）；不允许隐藏文件、凭据目录、符号链接或网络路径。' };
  }
}

function formatProjectLine(project: DshProjectSession, index: number): string {
  return `${index + 1}. ${project.current ? '【当前】' : ''}${project.workspaceTitle} · ${project.path} · ${project.sessionId.slice(-8)}${project.live && !project.current ? '（已打开）' : ''}`;
}

export async function handleSessionList(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.listProjects) {
    return { reply: '当前守护进程不支持项目会话列表（请升级插件并重启桥接）。', handled: true };
  }
  try {
    const projects = await ctx.listProjects();
    // Invalidate old numbering before delivery, so a partial/failed reply cannot
    // silently use either an unseen new list or the previous list's indices.
    ctx.updateSession({ sessionChoices: undefined });
    if (projects.length === 0) {
      return { reply: '暂无可用会话。发送 /new 或“新建会话”即可创建。', handled: true, sessionChoices: [] };
    }
    const lines = projects.map(formatProjectLine);
    return {
      reply: `📁 会话列表（共 ${projects.length} 个）:\n\n${lines.join('\n')}\n\n切换：/switch <序号或ID> 或“切换会话 2”\n新建：/new · 清空上下文：/clear`,
      handled: true,
      sessionChoices: projects.map((project) => project.sessionId),
    };
  } catch (err) {
    return { reply: `⚠️ 获取项目会话失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
  }
}

export async function handleSession(ctx: CommandContext, args: string): Promise<CommandResult> {
  const arg = args.trim();

  if (!arg) {
    if (!ctx.getStatus) {
      return { reply: '用法: /session <序号或ID>\n查看列表: /sessionlist', handled: true };
    }
    try {
      const status = await ctx.getStatus();
      const selected = (status as { selectedProject?: { workspaceTitle?: string; path?: string; sessionId?: string } | null }).selectedProject;
      if (selected?.sessionId) {
        return {
          reply: `当前会话：${selected.workspaceTitle || ''} · ${selected.path || ''} · ${selected.sessionId.slice(-8)}\n查看列表：/sessions · 清空上下文：/clear`,
          handled: true,
        };
      }
      return { reply: '当前尚未开始会话。发送 /new 立即创建，或直接发消息。\n查看已有会话：/sessions', handled: true };
    } catch (err) {
      return { reply: `⚠️ 获取状态失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
    }
  }

  const lower = arg.toLowerCase();
  if (lower === 'off' || lower === 'detach' || lower === 'unbind' || lower === '解除') {
    if (!ctx.detachProject) {
      return { reply: '当前守护进程不支持解除绑定。', handled: true };
    }
    try {
      const result = await ctx.detachProject();
      return {
        reply: `✅ 已解除项目会话绑定${result.daemon ? `（${result.daemon}）` : ''}`,
        handled: true,
      };
    } catch (err) {
      return { reply: `⚠️ 解除绑定失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
    }
  }

  if (!ctx.listProjects || !ctx.selectProject) {
    return { reply: '当前守护进程不支持项目绑定（请升级插件并重启桥接）。', handled: true };
  }

  try {
    const projects = await ctx.listProjects();
    if (projects.length === 0) {
      return { reply: '没有可绑定的项目会话。', handled: true };
    }

    let matches: DshProjectSession[];
    const exactId = projects.find((project) => project.sessionId === arg);
    const shortIds = arg.length >= 4 ? projects.filter((p) => p.sessionId.startsWith(arg) || p.sessionId.endsWith(arg)) : [];
    if (exactId) {
      matches = [exactId];
    } else if (/^\d+$/.test(arg) && !shortIds.length) {
      if (!ctx.session.sessionChoices) {
        return { reply: '请先发送 /sessions 查看列表，再使用序号切换。', handled: true };
      }
      const id = ctx.session.sessionChoices[Number(arg) - 1];
      matches = projects.filter((project) => project.sessionId === id);
    } else {
      const names = projects.filter((p) => p.workspaceTitle === arg || p.path === arg);
      matches = shortIds.length ? shortIds : names.length ? names : projects.filter((p) => p.path.includes(arg));
    }
    if (matches.length > 1) {
      return { reply: `匹配到多个会话：${arg}。请用 /sessions 查看后选择序号或完整 ID。`, handled: true };
    }
    const target = matches[0];
    if (!target) {
      return { reply: `未找到匹配会话（或列表已过期）：${arg}\n请用 /sessions 刷新列表。`, handled: true };
    }

    const result = await ctx.selectProject(target.sessionId);
    if (result.ok === false) throw new Error(String(result.error || '切换被拒绝'));
    return {
      reply: `✅ 已绑定项目会话：${target.workspaceTitle} · ${target.path}${result.daemon ? `\n${result.daemon}` : ''}`,
      handled: true,
    };
  } catch (err) {
    return { reply: `⚠️ 绑定失败：${err instanceof Error ? err.message : String(err)}`, handled: true };
  }
}

export function handleUnknown(cmd: string, _args: string): CommandResult {
  return {
    handled: true,
    reply: `未识别命令: /${cmd}\n输入 /help 查看可用命令`,
  };
}

// ---------------------------------------------------------------------------
// 多用户信任集（P1-2 / M1）
// ---------------------------------------------------------------------------

/**
 * owner 专属：把 userId 加入信任集。
 * - 当前模式非 manual 时只提示启用方法（bootstrap 模式自动拉人，无需手动加）。
 * - 加自己无效；userId 形态校验失败直接拒绝。
 */
export function handleTrust(ctx: CommandContext, args: string): CommandResult {
  if (!ctx.trust) {
    return { reply: '当前为 owner-only 模式，不需要手动添加信任用户。\n要放开多人对话，请先用 /trustmode 切换到 bootstrap 或 manual。', handled: true };
  }
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /trust 仅 owner 可用（信任集管理权限）。', handled: true };
  }
  const arg = args.trim();
  if (!arg) {
    return { reply: '用法: /trust <userId> [备注]\n例: /trust wxid_abc 老婆\n  /trustlist 查看当前信任集', handled: true };
  }
  const firstSpace = arg.search(/\s/);
  const userId = (firstSpace === -1 ? arg : arg.slice(0, firstSpace)).trim();
  const note = (firstSpace === -1 ? '' : arg.slice(firstSpace + 1).trim()) || undefined;
  if (userId === ownerId) {
    return { reply: 'ℹ️ owner 永远放行，不需要把自己加入信任集。', handled: true };
  }
  if (!isPlausibleUserId(userId)) {
    return { reply: '⚠️ userId 格式不合法（应为 4-64 位字母/数字/_ . @ = -）。', handled: true };
  }
  const file = ctx.trust.load();
  const next = addTrusted(file, userId, 'owner', note);
  ctx.trust.save(next);
  return {
    reply: `✅ 已添加信任用户：${userId}${note ? `（${note}）` : ''}\n当前模式：${ctx.trust.listModeLabel()}\n（手动模式才会拦截陌生人；bootstrap 模式首位陌生人会自动入集，无需 /trust。）`,
    handled: true,
  };
}

/** owner 专属：从信任集移除 userId。 */
export function handleDistrust(ctx: CommandContext, args: string): CommandResult {
  if (!ctx.trust) {
    return { reply: '当前为 owner-only 模式，没有信任集可管理。', handled: true };
  }
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /distrust 仅 owner 可用。', handled: true };
  }
  const userId = args.trim();
  if (!userId) {
    return { reply: '用法: /distrust <userId>\n查看列表：/trustlist', handled: true };
  }
  if (!isPlausibleUserId(userId)) {
    return { reply: '⚠️ userId 格式不合法。', handled: true };
  }
  const file = ctx.trust.load();
  if (!file.trusted[userId]) {
    return { reply: `ℹ️ ${userId} 不在信任集中。\n查看列表：/trustlist`, handled: true };
  }
  const next = removeTrusted(file, userId);
  ctx.trust.save(next);
  return { reply: `✅ 已吊销：${userId}（后续消息会被拒绝，已存在的会话保留只读）`, handled: true };
}

/** owner 专属：列出当前 trustMode + 信任集。 */
export function handleTrustList(ctx: CommandContext): CommandResult {
  if (!ctx.trust) {
    return { reply: '当前模式：owner-only（仅本机账号主人本人）\n要放开多人对话：/trustmode bootstrap|manual', handled: true };
  }
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /trustlist 仅 owner 可用。', handled: true };
  }
  const file = ctx.trust.load();
  const rows = listTrusted(file);
  const lines = [
    `🔐 信任模式：${ctx.trust.listModeLabel()}`,
    `owner：${ownerId || '（未绑定）'}`,
    `信任用户：${rows.length} 个`,
  ];
  if (rows.length > 0) {
    lines.push('');
    for (const r of rows) {
      const added = new Date(r.addedAt).toLocaleString('zh-CN');
      const seen = r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString('zh-CN') : '从未活跃';
      const note = r.note ? ` · ${r.note}` : '';
      lines.push(`- ${r.userId}（添加于 ${added} · 最近 ${seen}${note}）`);
    }
  }
  lines.push('');
  lines.push('管理：/trust <userId> [备注] · /distrust <userId> · /trustmode [模式]');
  return { reply: lines.join('\n'), handled: true };
}

/** owner 专属：查看或切换 trustMode。 */
export function handleTrustMode(ctx: CommandContext, args: string): CommandResult {
  const ownerId = ctx.ownerUserId;
  if (ownerId && ctx.fromUserId && ctx.fromUserId !== ownerId) {
    return { reply: '⚠️ /trustmode 仅 owner 可用。', handled: true };
  }
  const arg = args.trim().toLowerCase();
  if (!arg) {
    return {
      reply: `当前信任模式：${ctx.trust ? ctx.trust.listModeLabel() : 'owner-only'}\n\n可选：\n  owner-only  仅本机主人（默认，单用户行为）\n  bootstrap    首位陌生人自动入集（一次性）\n  manual       仅 /trust 添加的人\n\n切换：/trustmode <模式>`,
      handled: true,
    };
  }
  if (arg !== 'owner-only' && arg !== 'bootstrap' && arg !== 'manual') {
    return { reply: '⚠️ 模式必须是 owner-only / bootstrap / manual。', handled: true };
  }
  return {
    reply: `✅ 信任模式已切换为：${arg}（立即生效，后续入站消息按新模式判定）`,
    handled: true,
    setTrustMode: arg,
  };
}
