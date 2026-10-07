import type { AccountData } from './accounts.js';
import { DEFAULT_BASE_URL, saveAccount } from './accounts.js';
import { isPlausibleUserId } from '../trust.js';
import { requestLoginJson } from './login-transport.js';
import { WechatLoginError, safeLoginFailure } from './login-errors.js';

const QR_CODE_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
const QR_STATUS_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status`;
export type QrCheckResult =
  | { status: 'wait' | 'scaned' }
  | { status: 'confirmed'; account: AccountData }
  | { status: 'expired'; message: string }
  | { status: 'error'; message: string; retryable: boolean };

function text(value: unknown, maximum = 8192): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
function accepted(data: Record<string, unknown>): boolean {
  return !Object.hasOwn(data, 'ret') || data.ret === 0;
}
export function parseQrStartResponse(data: Record<string, unknown>): { qrcodeUrl: string; qrcodeId: string } {
  if (!accepted(data)) throw new WechatLoginError('rejected');
  if (!text(data.qrcode_img_content) || !text(data.qrcode, 4096) || /[\u0000-\u0020\u007f]/.test(data.qrcode)) throw new WechatLoginError('malformed');
  return { qrcodeUrl: data.qrcode_img_content, qrcodeId: data.qrcode };
}
export async function startQrLogin(): Promise<{ qrcodeUrl: string; qrcodeId: string }> {
  // Fresh login only: never enumerate or transmit tokens from other accounts.
  return parseQrStartResponse(await requestLoginJson(QR_CODE_URL, 15_000, JSON.stringify({ local_token_list: [] })));
}
function accountBaseUrl(value: unknown): string {
  if (value === undefined) return DEFAULT_BASE_URL;
  if (!text(value)) throw new WechatLoginError('malformed');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new WechatLoginError('redirect');
  return url.origin;
}
/** Validate before committing; Host supplies its current request/lifetime guard.
 * Raw server text, QR identifiers and credentials never enter error messages.
 */
export function parseQrStatusResponse(data: Record<string, unknown>, dataDir?: string, canCommit: () => boolean = () => true): QrCheckResult {
  if (!accepted(data)) return { status: 'error', message: '微信拒绝了此次扫码请求，请重新获取二维码。', retryable: false };
  if (data.status === 'wait' || data.status === 'scaned') return { status: data.status };
  if (data.status === 'expired') return { status: 'expired', message: '二维码已过期，请重新获取。' };
  if (data.status === 'confirmed') {
    if (!text(data.bot_token) || !text(data.ilink_bot_id, 128) || !text(data.ilink_user_id, 64) || !isPlausibleUserId(data.ilink_user_id)) {
      return { status: 'error', message: '微信确认信息不完整，未保存授权，请重新绑定。', retryable: false };
    }
    let baseUrl: string;
    try { baseUrl = accountBaseUrl(data.baseurl); } catch {
      return { status: 'error', message: '微信返回了不允许的服务地址，未保存授权。', retryable: false };
    }
    const account: AccountData = {
      botToken: data.bot_token, accountId: data.ilink_bot_id, userId: data.ilink_user_id,
      baseUrl, createdAt: new Date().toISOString(),
    };
    if (!canCommit()) return { status: 'expired', message: '本机扫码请求已结束，未保存授权，请重新获取二维码。' };
    saveAccount(account, dataDir);
    return { status: 'confirmed', account };
  }
  const unsupported: Record<string, string> = {
    need_verifycode: '微信要求填写手机配对码；当前预览版尚不支持这一步。请勿把配对码发送到聊天中。',
    verify_code_blocked: '微信暂时限制了配对码尝试，请稍后重新获取二维码。',
    scaned_but_redirect: '微信要求切换登录节点；当前预览版不自动跟随，以避免泄露扫码凭据。',
    binded_redirect: '微信提示已有绑定，但未返回本次授权；本机不会据此宣称绑定成功。',
  };
  return { status: 'error', message: typeof data.status === 'string' && Object.hasOwn(unsupported, data.status)
    ? unsupported[data.status] : '微信返回了当前版本不支持的扫码状态，请重新获取二维码。', retryable: false };
}
export async function checkQrStatus(qrcodeId: string, dataDir?: string, canCommit?: () => boolean): Promise<QrCheckResult> {
  if (!text(qrcodeId, 4096)) return { status: 'error', message: '无效的扫码请求。', retryable: false };
  let data: Record<string, unknown>;
  try {
    data = await requestLoginJson(`${QR_STATUS_URL}?qrcode=${encodeURIComponent(qrcodeId)}`, 35_000);
  } catch (error) {
    return { status: 'error', message: error instanceof WechatLoginError ? safeLoginFailure(error) : '二维码状态暂不可用，请稍后重试。',
      retryable: !(error instanceof WechatLoginError) || ['network', 'timeout', 'http'].includes(error.kind) };
  }
  return parseQrStatusResponse(data, dataDir, canCommit);
}
export async function waitForQrScan(qrcodeId: string, dataDir?: string): Promise<AccountData> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const result = await checkQrStatus(qrcodeId, dataDir, () => Date.now() < deadline);
    if (result.status === 'confirmed') return result.account;
    if (result.status === 'expired' || (result.status === 'error' && !result.retryable)) throw new Error(result.message);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('二维码等待超时，请重新获取。');
}
