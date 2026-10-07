import { appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { ensurePrivateDir } from '../portable/paths.js';
const LOG_DIR = join(DATA_DIR, 'logs');

/** Defense in depth only: logs are private state and must NEVER be shared by export. */
export function redact(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) return '';
  return raw.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer ***')
    .replace(/"[^"\n]*(?:token|secret|password|api_?key|aes_?key|qrcode)[^"\n]*"\s*:\s*"(?:\\.|[^"\\])*"/gi,
      match => `${match.slice(0, match.indexOf(':'))}: "***"`);
}
function write(level: string, message: string, data?: unknown): void {
  ensurePrivateDir(DATA_DIR);
  ensurePrivateDir(LOG_DIR);
  const files = readdirSync(LOG_DIR).filter(name => /^bridge-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort();
  while (files.length > 30) {
    // The name is positively matched, and the parent is the verified state log directory.
    unlinkSync(join(LOG_DIR, files.shift()!));
  }
  const now = new Date().toISOString();
  const line = [now, level, redact(message), data === undefined ? '' : redact(data)].filter(Boolean).join(' ') + '\n';
  appendFileSync(join(LOG_DIR, `bridge-${now.slice(0, 10)}.log`), line, { encoding: 'utf8', mode: 0o600 });
}
export const logger = {
  info: (message: string, data?: unknown) => write('INFO', message, data),
  warn: (message: string, data?: unknown) => write('WARN', message, data),
  error: (message: string, data?: unknown) => write('ERROR', message, data),
  debug: (message: string, data?: unknown) => {
    if (process.env.DSH_WECHAT_DEBUG === '1') write('DEBUG', message, data);
  },
};
