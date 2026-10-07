/** Fixed, credential-free diagnostics; never return a raw network exception. */
const messages = {
  certificate: '微信 HTTPS 证书校验失败。请检查系统时间、代理或证书链；不会绕过证书验证。',
  network: '无法连接微信登录服务。请检查网络、代理或防火墙后重试。',
  timeout: '微信登录请求超时，请稍后重试。',
  redirect: '微信登录请求返回了不允许的重定向，已停止以保护登录信息。',
  http: '微信登录服务返回 HTTP 错误，请稍后重试。',
  oversized: '微信登录响应超过安全大小限制，已停止处理。',
  malformed: '微信登录响应格式异常，请重新获取二维码。',
  rejected: '微信登录服务拒绝了此次请求，请稍后重新获取二维码。',
} as const
export type LoginFailureKind = keyof typeof messages
export class WechatLoginError extends Error {
  constructor(readonly kind: LoginFailureKind) {
    super(messages[kind])
    this.name = 'WechatLoginError'
  }
}
export function safeLoginFailure(error: WechatLoginError): string {
  return Object.hasOwn(messages, error.kind) ? messages[error.kind] : messages.network
}
export function classifyLoginFailure(error: unknown): WechatLoginError {
  if (error instanceof WechatLoginError) return error
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS/.test(code)) return new WechatLoginError('certificate')
  if (code === 'ETIMEDOUT') return new WechatLoginError('timeout')
  return new WechatLoginError('network')
}
