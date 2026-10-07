/** Explicit native Remote contribution; no fetch, URL base or HTTP fallback. */
import type { RemoteResult, TypertClientRemote, TypertRemoteContribution, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import {
  CONTROL_DESCRIPTOR, CONTROL_PACKAGE, decodeControlResponse, parseControlRequest,
  type ControlAction, type ControlValues,
} from '../host/contract.js'

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: CONTROL_PACKAGE,
  descriptors: [CONTROL_DESCRIPTOR],
}
export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'wechatPortableControl/request': (action: string, payloadJson: string) => Promise<RemoteResult<string>>
  }
  interface TypertRemoteNamespaceMap {
    wechatPortableControl: TypertRemoteNamespace<'wechatPortableControl'>
  }
}

export interface ControlClient {
  status(): Promise<ControlValues['status']>
  start(): Promise<ControlValues['start']>
  stop(): Promise<ControlValues['stop']>
  restart(): Promise<ControlValues['restart']>
  setWorkspace(workingDirectory: string): Promise<ControlValues['workspace.set']>
  startSetup(workingDirectory?: string): Promise<ControlValues['setup.start']>
  pollSetup(qrcodeId: string): Promise<ControlValues['setup.status']>
  cancelSetup(qrcodeId: string): Promise<ControlValues['setup.cancel']>
}

/** Unwrap the SDK's RemoteResult before decoding our bounded JSON response. */
export function createControlClient(remote: TypertClientRemote): ControlClient {
  const pendingPolls = new Map<string, Promise<ControlValues['setup.status']>>()
  async function request<Action extends ControlAction>(action: Action, payload: object = {}): Promise<ControlValues[Action]> {
    const payloadJson = JSON.stringify(payload)
    parseControlRequest(action, payloadJson)
    const result = await remote.wechatPortableControl.request(action, payloadJson)
    if (!result.ok) {
      // Assembly/carrier failure must be visible; never silently switch to HTTP.
      throw new Error(`Native WeChat IPC unavailable (${result.error.code}). Verify the Host plugin and strict Typert registration.`)
    }
    return decodeControlResponse(action, result.value)
  }
  return {
    status: () => request('status'),
    start: () => request('start'),
    stop: () => request('stop'),
    restart: () => request('restart'),
    setWorkspace: (workingDirectory) => request('workspace.set', { workingDirectory }),
    startSetup: (workingDirectory) => request('setup.start', workingDirectory === undefined ? {} : { workingDirectory }),
    pollSetup: (qrcodeId) => {
      const existing = pendingPolls.get(qrcodeId)
      if (existing) return existing
      const pending = request('setup.status', { qrcodeId }).finally(() => { pendingPolls.delete(qrcodeId) })
      pendingPolls.set(qrcodeId, pending)
      return pending
    },
    cancelSetup: async (qrcodeId) => {
      // Hiding/unmounting while a poll is in flight must not lose cancellation
      // to the Host mutation lock. No further QR polls are scheduled here.
      await pendingPolls.get(qrcodeId)?.catch(() => {})
      return request('setup.cancel', { qrcodeId })
    },
  }
}
