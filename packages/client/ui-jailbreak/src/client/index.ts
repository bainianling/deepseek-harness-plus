/**
 * Jailbreak control plugin, browser half: occupies the composer's named
 * `conversation.input.jailbreak` seat with an active-state status chip.
 * Jailbreak mode is entered through the command source; while the projection's
 * effective target is jailbreak mode the chip renders and executes /jailbreak
 * off through `command.execute`, otherwise the seat stays empty. Reads ride the
 * generic projection pair through the standard-kit `useProjection`; zero
 * client-side jailbreak state.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-conversation SlotMap merge (the input.jailbreak seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `jailbreak` SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-jailbreak-mode/client'
// Type-only: pulls the renderer/session Context merges (ctx.slots and seats).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { JailbreakChip } from './JailbreakChip.tsx'
import { en, zh, type JailbreakKey } from './locales.ts'

export type { JailbreakKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer jailbreak chip's copy. */
    jailbreak: JailbreakKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'jailbreak'

/** Injected business face of the composer jailbreak seat. */
export interface JailbreakChipInjected {
  /**
   * Leave jailbreak mode by executing /jailbreak off.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  exitJailbreakMode: () => Promise<string | null>
}

/** Required services: the seat's slot registry, commands Remote, and locale registry. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: register the jailbreak chip over the command channel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-jailbreak: dictionaries')

  ctx.slots.inject('conversation.input.jailbreak', () => ctx.slots.register({
    name: 'conversation.input.jailbreak',
    locale: NS,
    inject: (sessionId: SessionId): JailbreakChipInjected => ({
      // Failure strings stay English (error-surface policy: not localized).
      exitJailbreakMode: async () => {
        const result = await ctx.remote.commands.execute(sessionId, '/jailbreak off', [])
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /jailbreak off'
        return null
      },
    }),
  }, JailbreakChip))
}
