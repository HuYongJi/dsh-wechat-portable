/** Portable WeChat settings panel, mounted over the native Desktop Remote carrier. */
import type { Context } from '@deepseek-ai/cordis'
import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertClientRemote, TypertDisposer } from '@deepseek-ai/dsh-typert-protocol'
import { WechatBridgePanel } from './Panel.js'
import { createControlClient, TYPERT_REMOTE } from './remote.js'

// 0.2's slots package exports the pure typed core, not the removed ClientContext.
// The runtime slots provider adds declaration-aware, lifecycle-owned inject().
interface ClientSlots extends Pick<SlotCore, 'register'> {
  inject(name: keyof SlotMap & string, callback: () => () => void): void
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    remote: TypertClientRemote
    slots: ClientSlots
  }
}

export const inject = ['remote', 'slots']

export async function apply(ctx: Context): Promise<TypertDisposer> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  try {
    // $mount provides a distinct traced service. Injecting only `remote` does
    // not authorize reads of `remote.wechatPortableControl`. The dependency
    // belongs here, AFTER mounting: a top-level dependency would wait forever
    // for the very namespace this plugin is responsible for providing.
    const consumer = await ctx.inject(['remote.wechatPortableControl'], (panelCtx) => {
      const control = createControlClient(panelCtx.remote)
      panelCtx.slots.inject('settings.section', () => panelCtx.slots.register({
        name: 'settings.section',
        id: 'dsh-wechat-portable-panel',
        order: 55,
        label: () => '📱 微信桥接（Portable）',
        inject: () => ({ control }),
      }, WechatBridgePanel))
    })
    // Remove the consuming panel before withdrawing its namespace. Both the
    // child fiber and the contribution are also owned by the parent lifetime.
    return async () => {
      await consumer.dispose()
      await unmount()
    }
  } catch (error) {
    await unmount()
    throw error
  }
}
