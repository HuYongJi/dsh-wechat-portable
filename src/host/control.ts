/** Native Desktop IPC service. This entry is also the package's ./typert artifact. */
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WechatLoginError, safeLoginFailure } from '../bridge/wechat/login-errors.js'
import type { PeerScope, TypertDisposer, TypertRegistryContract } from '@deepseek-ai/dsh-typert-protocol'
import {
  CONTROL_DESCRIPTOR, CONTROL_NAMESPACE, CONTROL_PACKAGE, ControlError,
  encodeControlResponse, parseControlRequest, parseControlValue,
  type ControlMessage, type ControlSetup, type ControlSetupStatus, type ControlStatus, type ControlWorkspace,
} from './contract.js'

/** Same descriptor shape as the production 0.2 generated Host artifacts. */
export const TYPERT = {
  package: CONTROL_PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: [CONTROL_DESCRIPTOR],
  model: {
    services: [{
      key: CONTROL_NAMESPACE,
      tags: [],
      exportName: 'WechatPortableControl',
      description: 'Local operator control of the single-owner portable WeChat bridge.',
      members: [{ kind: 'method', name: 'request', signature: 'request(action: string, payloadJson: string): Promise<string>' }],
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export interface ControlHandlers {
  available(): boolean
  status(): Promise<ControlStatus> | ControlStatus
  start(): Promise<ControlMessage>
  stop(): Promise<ControlMessage>
  restart(): Promise<ControlMessage>
  setWorkspace(workingDirectory: string): Promise<ControlWorkspace> | ControlWorkspace
  startSetup(workingDirectory?: string): Promise<ControlSetup>
  pollSetup(qrcodeId: string): Promise<ControlSetupStatus>
  cancelSetup(qrcodeId: string): Promise<ControlMessage> | ControlMessage
}

/** Pure boundary, independently testable without a Host, filesystem or network. */
export function createControlRequestHandler(handlers: ControlHandlers): (action: string, payloadJson: string) => Promise<string> {
  let mutating = false
  return async (action, payloadJson) => {
    let ownsMutation = false
    try {
      const request = parseControlRequest(action, payloadJson)
      if (!handlers.available()) throw new ControlError('WeChat bridge is unavailable or unloading', 'unavailable')
      if (request.action !== 'status') {
        if (mutating) throw new ControlError('Another native control operation is still running', 'busy')
        mutating = true
        ownsMutation = true
      }
      // Deliberately not handlers[action]: the finite cases are the authority boundary.
      let value: unknown
      switch (request.action) {
        case 'status': value = await handlers.status(); break
        case 'start': value = await handlers.start(); break
        case 'stop': value = await handlers.stop(); break
        case 'restart': value = await handlers.restart(); break
        case 'workspace.set': value = await handlers.setWorkspace(request.workingDirectory); break
        case 'setup.start': value = await handlers.startSetup(request.workingDirectory); break
        case 'setup.status': value = await handlers.pollSetup(request.qrcodeId); break
        case 'setup.cancel': value = await handlers.cancelSetup(request.qrcodeId); break
      }
      if (!handlers.available()) throw new ControlError('WeChat bridge unloaded during the request', 'unavailable')
      return encodeControlResponse({ ok: true, value: parseControlValue(request.action, value) })
    } catch (error) {
      // Never echo arbitrary exception text: network errors can contain a QR URL/token.
      return encodeControlResponse({ ok: false, error: error instanceof ControlError
        ? { code: error.code, message: error.message }
        : { code: 'operation-failed', message: error instanceof WechatLoginError ? safeLoginFailure(error) : '原生控制操作失败；未更改权限设置。请检查本机目录或插件运行状态。' } })
    } finally {
      if (ownsMutation) mutating = false
    }
  }
}

/** Gateway-owned identity only; account/user IDs in a payload confer no authority. */
export function assertOperatorPeer(peer: Pick<PeerScope, 'id'> | undefined, operator: Pick<PeerScope, 'id'> | undefined): void {
  if (!peer || !operator || typeof peer.id !== 'string' || !peer.id || typeof operator.id !== 'string' || peer.id !== operator.id) {
    throw new ControlError('Native WeChat control is restricted to the local Host operator', 'forbidden')
  }
}

export class WechatPortableControl extends TypertRemoteService {
  private readonly dispatch: ReturnType<typeof createControlRequestHandler>

  constructor(ctx: Context, handlers: ControlHandlers) {
    super(ctx, CONTROL_NAMESPACE)
    const lifetime = { active: true }
    ctx.effect(() => () => { lifetime.active = false }, 'wechat-portable: native control lifetime')
    this.dispatch = createControlRequestHandler({ ...handlers, available: () => lifetime.active && handlers.available() })
  }

  // No @Remote SRC fallback: the strict contribution must be registered first.
  async request(action: string, payloadJson: string): Promise<string> {
    try {
      const invocation = this.ctx.invocation
      const connection = this.ctx.get('connection') as { readonly operator?: PeerScope } | undefined
      assertOperatorPeer(invocation?.peer, connection?.operator)
      if (invocation?.signal.aborted) throw new ControlError('Native request was cancelled', 'unavailable')
      return await this.dispatch(action, payloadJson)
    } catch (error) {
      return encodeControlResponse({ ok: false, error: {
        code: error instanceof ControlError ? error.code : 'forbidden',
        message: error instanceof ControlError ? error.message : 'Local operator identity is unavailable',
      } })
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { wechatPortableControl: WechatPortableControl }
}

/**
 * DSH 0.2 typert-loader owns the ./typert contribution and withdraws it on
 * unmount. Its scan is asynchronous: manually registering here would race that
 * scan and cause duplicate registration. No decorator/SRC fallback is exposed.
 */
export function registerNativeControl(ctx: Context, handlers: ControlHandlers): void {
  ctx.inject(['typert'], (nativeCtx) => {
    new WechatPortableControl(nativeCtx, handlers)
  })
}
