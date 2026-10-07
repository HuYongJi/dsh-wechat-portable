import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ControlSetup, ControlStatus } from '../host/contract.js'
import type { ControlClient } from './remote.js'

const panelStyle: React.CSSProperties = {
  padding: 16, borderRadius: 10, fontSize: 13, lineHeight: 1.6,
  color: 'var(--dsw-alias-label-primary, #1f2328)',
  background: 'var(--dsw-alias-bg-module-platform, rgba(127,127,127,.06))',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
}
const rowStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '10px 0' }
const buttonStyle: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, cursor: 'pointer', color: 'inherit',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4))',
}
const inputStyle: React.CSSProperties = {
  ...buttonStyle, cursor: 'text', minWidth: 200, width: 'min(100%, 540px)', boxSizing: 'border-box',
}
const hintStyle: React.CSSProperties = { fontSize: 12, opacity: 0.75 }
const errorStyle: React.CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-danger, #c44848)' }

export interface WechatBridgePanelProps extends SettingsSectionOwnerProps { control: ControlClient }

/** Single-owner alpha panel. QR secrets live only in component memory, never in exports/storage/logs. */
export function WechatBridgePanel({ control }: WechatBridgePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<ControlStatus | null>(null)
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [message, setMessage] = useState('')
  const [qr, setQr] = useState<ControlSetup | null>(null)
  const [qrMessage, setQrMessage] = useState('')
  const mounted = useRef(false)
  const busyRef = useRef(false)
  const refreshInFlight = useRef(false)
  const qrId = useRef('')
  const epoch = useRef(0)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const next = await control.status()
      if (!mounted.current) return
      setStatus(next)
      setWorkingDirectory((previous) => previous || next.workingDirectory)
      setStatusError('')
    } catch (err) {
      if (mounted.current) setStatusError(err instanceof Error ? err.message : '无法读取原生 IPC 状态')
    } finally { refreshInFlight.current = false }
  }, [control])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => {
      mounted.current = false
      epoch.current++
      clearInterval(timer)
      const id = qrId.current
      qrId.current = ''
      if (id) void control.cancelSetup(id).catch(() => {})
    }
  }, [control, refresh])

  useEffect(() => {
    if (!qr) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + 5 * 60_000
    const poll = async () => {
      if (cancelled || !mounted.current) return
      try {
        if (Date.now() >= deadline) throw new Error('二维码已超时，请重新获取。')
        const result = await control.pollSetup(qr.qrcodeId)
        if (cancelled || !mounted.current) return
        setQrMessage(result.message || (result.status === 'scaned' ? '已扫码，请在微信确认。' : '等待扫码…'))
        if (result.status === 'confirmed') {
          qrId.current = ''
          setQr(null)
          setMessage('绑定成功。请手动启动桥接；权限审批保持原设置。')
          void refresh()
          return
        }
        if (result.status === 'expired' || result.status === 'idle' || (result.status === 'error' && !result.retryable)) {
          qrId.current = ''
          setQr(null)
          return
        }
        timer = setTimeout(() => { void poll() }, 3000)
      } catch (err) {
        if (cancelled || !mounted.current) return
        qrId.current = ''
        setQr(null)
        setQrMessage(err instanceof Error ? err.message : '扫码状态读取失败，请重试。')
        void control.cancelSetup(qr.qrcodeId).catch(() => {})
      }
    }
    timer = setTimeout(() => { void poll() }, 1000)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [qr, control, refresh])

  async function run(label: string, operation: () => Promise<string>): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(label)
    setError('')
    setMessage('')
    const generation = epoch.current
    try {
      const text = await operation()
      if (!mounted.current || generation !== epoch.current) return
      setMessage(text)
      await refresh()
    } catch (err) {
      if (mounted.current && generation === epoch.current) setError(err instanceof Error ? err.message : '原生控制失败')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy('')
    }
  }

  async function beginSetup(): Promise<void> {
    const generation = epoch.current
    await run('获取二维码', async () => {
      const next = await control.startSetup(workingDirectory.trim() || undefined)
      if (!mounted.current || generation !== epoch.current) {
        void control.cancelSetup(next.qrcodeId).catch(() => {})
        return ''
      }
      qrId.current = next.qrcodeId
      setQr(next)
      setQrMessage('请使用本机主人微信扫码，并在微信中确认。')
      return ''
    })
  }

  function cancelSetup(): void {
    const id = qrId.current
    qrId.current = ''
    epoch.current++
    setQr(null)
    setQrMessage('本地二维码已隐藏，已停止后续轮询。')
    if (id) void control.cancelSetup(id).catch(() => {})
  }

  const disabled = !!busy || !status?.ready || !!qr
  return (
    <section style={panelStyle} aria-label="Portable 微信桥接">
      <h3 style={{ marginTop: 0 }}>微信桥接 · 单用户 Alpha.7</h3>
      <p style={hintStyle}>通过 DSH 原生 Remote / Desktop IPC 管理当前 profile，不使用浏览器 HTTP 后备接口。</p>
      <div aria-live="polite">
        {status ? <>
          <div>桥接：{status.running ? '运行中' : '已停止'}{status.pid ? `（PID ${status.pid}）` : ''}</div>
          <div>微信：{status.paired ? '已绑定主人账号' : '未绑定'} · 仅主人可用 · 活跃会话：{status.activeSessions}</div>
          {!status.ready && <div>Host 正在初始化，请稍后刷新。</div>}
        </> : <div>正在读取状态…</div>}
      </div>
      <div style={rowStyle}>
        <button style={buttonStyle} disabled={disabled || status?.running || !status?.paired} onClick={() => void run('启动', async () => (await control.start()).message)}>启动</button>
        <button style={buttonStyle} disabled={disabled || !status?.running} onClick={() => void run('停止', async () => (await control.stop()).message)}>停止</button>
        <button style={buttonStyle} disabled={disabled || !status?.paired} onClick={() => void run('重启', async () => (await control.restart()).message)}>重启</button>
        <button style={buttonStyle} disabled={!!busy} onClick={() => void refresh()}>刷新</button>
        {busy && <span role="status">{busy}…</span>}
      </div>
      <hr style={{ opacity: 0.2 }} />
      <label htmlFor="wechat-portable-workspace">默认工作目录</label>
      <div style={rowStyle}>
        <input id="wechat-portable-workspace" style={inputStyle} value={workingDirectory} disabled={!!busy || !!qr}
          autoComplete="off" spellCheck={false} placeholder="本机已有目录的绝对路径"
          onChange={(event) => setWorkingDirectory(event.target.value)} />
        <button style={buttonStyle} disabled={disabled || !workingDirectory.trim()} onClick={() => void run('保存目录', async () => {
          const result = await control.setWorkspace(workingDirectory)
          if (mounted.current) setWorkingDirectory(result.workingDirectory)
          return result.message
        })}>保存目录</button>
      </div>
      <p style={hintStyle}>首次使用请先创建此目录或选择已有文件夹；保存不会创建目录。已有会话和权限策略不变，变更目录后请重启桥接并新建会话。</p>
      <hr style={{ opacity: 0.2 }} />
      <h4>扫码绑定</h4>
      <p style={hintStyle}>请先停止桥接并等待活跃会话结束。绑定不会自动启动桥接。二维码包含登录秘密，请勿分享或截图导出。</p>
      <div style={rowStyle}>
        <button style={buttonStyle} disabled={disabled || status?.running || !!status?.activeSessions} onClick={() => void beginSetup()}>获取绑定二维码</button>
        {qr && <button style={buttonStyle} onClick={cancelSetup}>隐藏二维码 / 停止轮询</button>}
      </div>
      {qr && <img src={qr.qrcodeDataUrl} alt="微信绑定二维码，仅供本机主人扫描" width={280} height={280}
        draggable={false} style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />}
      {qrMessage && <p role="status">{qrMessage}</p>}
      {message && <p role="status">{message}</p>}
      {(error || statusError) && <p role="alert" style={errorStyle}>{error || statusError}</p>}
    </section>
  )
}
