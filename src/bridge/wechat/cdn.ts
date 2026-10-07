import { decryptAesEcb } from './crypto.js';
import { CDN_BASE_URL } from '../constants.js';
import { MAX_MEDIA_BYTES } from '../safe-files.js';

export function buildCdnDownloadUrl(encryptQueryParam: string): string {
  if (!/^[A-Za-z0-9%=&+._~\-/]+$/.test(encryptQueryParam) || encryptQueryParam.length > 8192) throw new Error('Invalid CDN query parameter');
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}
export async function readLimitedBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new Error('CDN response has no body');
  const length = response.headers.get('content-length');
  if (length && Number(length) > maximum) { await response.body.cancel(); throw new Error('Attachment exceeds size limit'); }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Attachment exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function downloadAndDecrypt(encryptQueryParam: string, aesKeyBase64: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(buildCdnDownloadUrl(encryptQueryParam), { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`CDN download failed: HTTP ${response.status}`);
    // Keep the deadline active until the entire body is read, not only headers.
    const encrypted = await readLimitedBody(response, MAX_MEDIA_BYTES + 16);
    const raw = /^[a-fA-F0-9]{32}$/.test(aesKeyBase64) ? Buffer.from(aesKeyBase64, 'hex') : Buffer.from(aesKeyBase64, 'base64');
    const aesKey = raw.length === 16 ? raw : Buffer.from(raw.toString('utf8'), 'hex');
    if (aesKey.length !== 16) throw new Error('Invalid media encryption key');
    return decryptAesEcb(aesKey, encrypted);
  } finally { clearTimeout(timer); }
}
