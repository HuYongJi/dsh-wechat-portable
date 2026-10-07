import { join } from 'node:path';
import { readdirSync, lstatSync } from 'node:fs';
import { loadJson, saveJson, validateAccountId } from '../store.js';
import { DATA_DIR } from '../constants.js';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export interface AccountData {
  botToken: string;
  accountId: string;
  baseUrl: string;
  userId: string;
  createdAt: string;
}
function accountPath(accountId: string, dataDir: string): string {
  validateAccountId(accountId);
  return join(dataDir, 'accounts', `${accountId}.json`);
}
export function saveAccount(data: AccountData, dataDir: string = DATA_DIR): void {
  saveJson(accountPath(data.accountId, dataDir), data);
}
export function loadAccount(accountId: string, dataDir: string = DATA_DIR): AccountData | null {
  const path = accountPath(accountId, dataDir);
  try { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return null; } catch { return null; }
  return loadJson<AccountData | null>(path, null);
}
export function loadLatestAccount(dataDir: string = DATA_DIR): AccountData | null {
  try {
    const folder = join(dataDir, 'accounts');
    const files = readdirSync(folder).filter(name => name.endsWith('.json'))
      .map(name => ({ name, stat: lstatSync(join(folder, name)) }))
      .filter(item => item.stat.isFile() && !item.stat.isSymbolicLink())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return files.length ? loadAccount(files[0].name.slice(0, -5), dataDir) : null;
  } catch { return null; }
}
