import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';
import { splitWechatText } from './wechat/text.js';

export interface PendingItem {
  text: string;
  role: 'interstitial' | 'final';
  queuedAt: number;
  /** 目标微信用户（多用户下区分补发给谁；缺省回退 owner）。 */
  userId?: string;
}

const QUEUE_DIR = join(DATA_DIR, 'pending-queue');

function queuePath(accountId: string): string {
  return join(QUEUE_DIR, `${accountId}.json`);
}

function ensureDir(): void {
  if (!existsSync(QUEUE_DIR)) {
    mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

export function loadPendingQueue(accountId: string): PendingItem[] {
  try {
    const path = queuePath(accountId);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn('Failed to load pending queue', {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function savePendingQueue(accountId: string, items: PendingItem[]): void {
  try {
    ensureDir();
    writeFileSync(queuePath(accountId), JSON.stringify(items, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('Failed to save pending queue', {
      accountId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function appendPending(accountId: string, item: PendingItem): PendingItem[] {
  const items = loadPendingQueue(accountId);
  items.push(item);
  savePendingQueue(accountId, items);
  return items;
}

export function clearPending(accountId: string): void {
  savePendingQueue(accountId, []);
}

export function hasPending(accountId: string): boolean {
  return loadPendingQueue(accountId).length > 0;
}

/** Single daemon writer; queue entries are ready-to-send text, never Markdown input. */
export function createPendingQueueDrainer(
  accountId: string,
  ownerUserId: string,
  send: (target: string, text: string) => Promise<void>,
): () => Promise<void> {
  let active = false;
  return async () => {
    if (active) return;
    active = true;
    try {
      const items = loadPendingQueue(accountId);
      if (items.length === 0) return;
      const remaining: PendingItem[] = [];
      for (const item of items) {
        if (item.role !== 'final') continue;
        const target = item.userId || ownerUserId;
        if (!ownerUserId || target !== ownerUserId) continue;
        // Legacy entries also remain verbatim: guessing whether text was already
        // formatted could silently strip Markdown-looking literal code.
        const chunks = splitWechatText(item.text);
        let index = 0;
        try {
          for (; index < chunks.length; index++) await send(target, chunks[index]);
          logger.info('Pending queue item delivered', { accountId, target });
        } catch (err) {
          logger.warn('Pending queue delivery failed, keep for retry', {
            accountId,
            error: err instanceof Error ? err.message : String(err),
          });
          remaining.push({ ...item, text: chunks.slice(index).join('') });
        }
      }
      // Preserve new replies appended while awaiting network sends; the active
      // guard prevents another timer from draining/rewriting the same snapshot.
      const appended = loadPendingQueue(accountId).slice(items.length);
      savePendingQueue(accountId, [...remaining, ...appended]);
    } finally {
      active = false;
    }
  };
}
