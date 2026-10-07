import { Agent, request, type RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { WechatLoginError, classifyLoginFailure } from './login-errors.js'

export const MAX_LOGIN_RESPONSE_BYTES = 64 * 1024

/** Per-request verified TLS, even when another application component has set
 * NODE_TLS_REJECT_UNAUTHORIZED=0. Never mutate process.env or global agents.
 * No redirects, cookies, ambient bot tokens, or raw-response/error logging.
 */
export function requestLoginJson(url: string, timeoutMs: number, body?: string): Promise<Record<string, unknown>> {
  let target: URL
  try { target = new URL(url) } catch { return Promise.reject(new WechatLoginError('malformed')) }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) return Promise.reject(new WechatLoginError('redirect'))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 35_000) return Promise.reject(new WechatLoginError('malformed'))
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, rejectUnauthorized: true })
    let req: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let finished = false
    const timer = setTimeout(() => fail(new WechatLoginError('timeout')), timeoutMs)
    function cleanup(): void {
      clearTimeout(timer)
      response?.destroy()
      req?.destroy()
      agent.destroy()
    }
    function fail(error: unknown): void {
      if (finished) return
      finished = true
      cleanup()
      reject(classifyLoginFailure(error))
    }
    const options: RequestOptions = {
      agent, rejectUnauthorized: true, method: body === undefined ? 'GET' : 'POST', maxHeaderSize: 16 * 1024,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', ...(body === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      }) },
    }
    try {
      req = request(target, options, incoming => {
        response = incoming
        if (finished) { incoming.destroy(); return }
        // The Node HTTPS client never follows redirects; reject them explicitly.
        const status = incoming.statusCode ?? 0
        if (status >= 300 && status < 400) { fail(new WechatLoginError('redirect')); return }
        if (status < 200 || status >= 300) { fail(new WechatLoginError('http')); return }
        const length = incoming.headers['content-length']
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_LOGIN_RESPONSE_BYTES)) { fail(new WechatLoginError('oversized')); return }
        let received = 0
        const chunks: Buffer[] = []
        incoming.on('data', (value: Buffer | string) => {
          if (finished) return
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          received += chunk.length
          if (received > MAX_LOGIN_RESPONSE_BYTES) { fail(new WechatLoginError('oversized')); return }
          chunks.push(chunk)
        })
        incoming.once('aborted', () => fail(new WechatLoginError('network')))
        incoming.once('error', fail)
        incoming.once('end', () => {
          if (finished) return
          let parsed: unknown
          try { parsed = JSON.parse(Buffer.concat(chunks, received).toString('utf8')) } catch { fail(new WechatLoginError('malformed')); return }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { fail(new WechatLoginError('malformed')); return }
          finished = true
          cleanup()
          resolve(parsed as Record<string, unknown>)
        })
      })
      req.once('error', fail)
      req.end(body)
    } catch (error) { fail(error) }
  })
}
