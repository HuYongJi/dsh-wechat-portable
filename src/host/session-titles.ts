import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'

interface TitleSnapshot {
  values: { title?: unknown }
}

/** Optional read faces already used by DSH's client session list. */
export interface SessionTitleSources {
  projections?: {
    cachedSnapshot(session: Session, keys?: readonly string[]): TitleSnapshot | undefined
  }
  cache?: {
    cachedSnapshot(header: SessionHeader, keys?: readonly string[]): TitleSnapshot | undefined
    cachedPredecessorTitle?(header: SessionHeader): TitleSnapshot | undefined
  }
}

/**
 * Read the same title projection as the desktop list, without resuming a session,
 * replaying history, writing checkpoints, or generating titles/model requests.
 * Keep the exact live Session and the complete persisted lifecycle header.
 */
export function readClientSessionTitle(
  sources: SessionTitleSources,
  header?: SessionHeader,
  session?: Session,
): string | undefined {
  try {
    // A live missing/null title must not be replaced by an older disk value.
    // Predecessor fallback is at snapshot level, just like api-session.list.
    const snapshot = session !== undefined
      ? sources.projections?.cachedSnapshot(session, ['title'])
      : header === undefined ? undefined
        : sources.cache?.cachedSnapshot(header, ['title']) ?? sources.cache?.cachedPredecessorTitle?.(header)
    const title = snapshot?.values.title
    return typeof title === 'string' && title.trim() ? title : undefined
  } catch {
    // A missing/unavailable projection must not hide every other session row.
    return undefined
  }
}
