export interface ParsedCommand {
  name: string;
  args: string;
}

/** Only whole-message, explicit phrases are commands. Never match quoted prose/code. */
export function parseCommand(input: string): ParsedCommand | undefined {
  const text = input.trim();
  const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (slash) return { name: slash[1].toLowerCase(), args: (slash[2] || '').trim() };

  const phrase = text.replace(/[。！？!?]$/, '').trim();
  const simple: Record<string, string> = {
    '新建会话': 'new', '创建新会话': 'new', '开启新会话': 'new', '开新会话': 'new',
    '新建对话': 'new', '开始新对话': 'new',
    '会话列表': 'sessions', '查看会话': 'sessions', '查看会话列表': 'sessions', '列出会话': 'sessions', '列出所有会话': 'sessions',
    '当前会话': 'session', '查看当前会话': 'session',
    '清空上下文': 'clear', '清除上下文': 'clear', '清空会话': 'clear', '清除会话': 'clear',
    '停止任务': 'stop', '停止当前任务': 'stop',
    '会话帮助': 'help',
    '切换会话': 'switch', '切换到会话': 'switch',
  };
  if (Object.hasOwn(simple, phrase)) return { name: simple[phrase], args: '' };
  const target = /^切换(?:到)?会话(?:\s+|[：:]\s*)([^\r\n]+)$/.exec(phrase)
    ?? /^切换到?第\s*(\d+)\s*个会话$/.exec(phrase);
  if (target) return { name: 'switch', args: target[1].trim() };
  return undefined;
}

/** These commands cancel a running turn and discard messages waiting behind it. */
export function interruptsTurn(command: ParsedCommand | undefined): boolean {
  if (!command) return false;
  if (['stop', 'new', 'clear', 'reset'].includes(command.name)) return !command.args;
  return ['switch', 'session'].includes(command.name) && !!command.args;
}
