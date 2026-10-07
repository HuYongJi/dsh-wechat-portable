import type { Session } from '../session.js';
import type { DshProjectSession } from '../dsh-client.js';
import { logger } from '../logger.js';
import { parseCommand } from './parser.js';
import { handleHelp, handleClear, handleNew, handleCwd, handleModel, handleStatus, handleHistory, handleReset, handleUndo, handleVersion, handlePrompt, handleSend, handleSession, handleSessionList, handleTrust, handleDistrust, handleTrustList, handleTrustMode, handleUnknown } from './handlers.js';
import type { TrustFile, TrustMode } from '../trust.js';

export interface CommandContext {
  accountId: string;
  /** 当前消息发送者 userId（多用户支持 P1-2 / M1：用于 trust 判定）。 */
  fromUserId?: string;
  /** 绑定账号的 owner userId。 */
  ownerUserId?: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  createSession: () => Promise<Record<string, unknown>>;
  clearContext: (reset?: boolean) => Promise<void>;
  stopTask: () => Promise<void>;
  getChatHistoryText?: (limit?: number) => string;
  text: string;
  listProjects?: () => Promise<DshProjectSession[]>;
  selectProject?: (sessionId: string) => Promise<Record<string, unknown>>;
  detachProject?: () => Promise<Record<string, unknown>>;
  getStatus?: () => Promise<Record<string, unknown>>;
  /** 信任集相关钩子（owner-only 模式不会注入）。 */
  trust?: {
    load(): TrustFile;
    save(file: TrustFile): void;
    listModeLabel(): string;
  };
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  dshPrompt?: string;
  sendFile?: string; // Absolute path to a file to send to the user
  /** Commit the numbering only after the complete list was delivered. */
  sessionChoices?: string[];
  /** 命令期望的 trustMode 变更（main 负责写入 trust.json——信任集唯一真相源）。 */
  setTrustMode?: TrustMode;
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /history  - Show recent conversation history
 */
export async function routeCommand(ctx: CommandContext): Promise<CommandResult> {
  const command = parseCommand(ctx.text);
  if (!command) return { handled: false };
  const { name: cmd, args } = command;

  logger.info('Conversation command received', { command: cmd, argumentLength: args.length });
  if (['new', 'clear', 'reset', 'stop'].includes(cmd) && args) {
    return { handled: true, reply: `用法：/${cmd}（不带参数）` };
  }
  if (['trust', 'distrust', 'untrust', 'trustmode'].includes(cmd)) {
    return { handled: true, reply: '此便携预览版仅供扫码绑定者本人使用，不支持添加其他用户。' };
  }

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'stop':
      try {
        await ctx.stopTask();
        return { handled: true, reply: '⏹ 已停止当前任务，排队中的消息已清空。' };
      } catch {
        return { handled: true, reply: '⚠️ 停止失败，请检查电脑端任务状态。' };
      }
    case 'clear':
      return handleClear(ctx);
    case 'new':
      return handleNew(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'send':
      return handleSend(ctx, args);
    case 'sessionlist':
    case 'sessions':
    case 'projects':
      return handleSessionList(ctx);
    case 'switch':
      if (!args) return { handled: true, reply: '用法：/switch <序号、ID或唯一标题>（兼容项目名）\n先用 /sessions 查看列表。' };
      return handleSession(ctx, args);
    case 'session':
      return handleSession(ctx, args);
    case 'trust':
      return handleTrust(ctx, args);
    case 'distrust':
    case 'untrust':
      return handleDistrust(ctx, args);
    case 'trustlist':
    case 'trusts':
      return handleTrustList(ctx);
    case 'trustmode':
      return handleTrustMode(ctx, args);
    case 'version':
    case 'v':
      return handleVersion();
    default:
      return handleUnknown(cmd, args);
  }
}
