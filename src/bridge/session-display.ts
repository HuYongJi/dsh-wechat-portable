import type { DshProjectSession } from './dsh-client.js'

type SessionLabel = Pick<DshProjectSession, 'sessionId'> & Partial<Pick<DshProjectSession, 'title' | 'workspaceTitle'>>

/** Keep labels on one line, including names supplied by older or custom Hosts. */
export function cleanSessionLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B[@-_]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ').trim()
}

function compact(value: string): string {
  const characters = Array.from(value)
  return characters.length > 120 ? `${characters.slice(0, 119).join('')}…` : value
}

export function sessionDisplayTitle(session: Pick<SessionLabel, 'title'>): string {
  return cleanSessionLabel(session.title) || '未命名会话'
}

function sessionDetails(session: SessionLabel): string {
  return [compact(cleanSessionLabel(session.workspaceTitle)), cleanSessionLabel(session.sessionId).slice(-8)]
    .filter(Boolean).join(' · ')
}

export function formatSessionSummary(session: SessionLabel): string {
  return `${compact(sessionDisplayTitle(session))}\n   ${sessionDetails(session)}`
}

export function formatSessionListItem(session: SessionLabel & { current?: boolean; live?: boolean }, index: number): string {
  return `${index + 1}. ${session.current ? '【当前】' : ''}${compact(sessionDisplayTitle(session))}${session.live && !session.current ? '（已打开）' : ''}\n   ${sessionDetails(session)}`
}
