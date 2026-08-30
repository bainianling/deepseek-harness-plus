import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the input.jailbreak seat
// and its {locked} owner share).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { JailbreakChipInjected } from './index.ts'
import css from './JailbreakChip.module.css'

/** Full jailbreak-seat component props: runtime share (standard kit + locked owner prop) & injected share & the locale seat. */
export type JailbreakChipProps =
  PropsRuntime<'conversation.input.jailbreak'> & InjectFace<JailbreakChipInjected> & PropsLocale<'jailbreak'>

/**
 * Jailbreak-mode status over the host-computed `jailbreak` projection. The chip
 * renders only while the effective target is jailbreak mode
 * (`pending ? !active : active` — a folded host value, not client optimism) and
 * executes /jailbreak off.
 */
export function JailbreakChip({ useProjection, locked, exitJailbreakMode, t }: JailbreakChipProps) {
  const jailbreak = useProjection('jailbreak')
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  if (jailbreak === undefined) return null
  const target = jailbreak.pending ? !jailbreak.active : jailbreak.active
  if (!target) return null

  const off = (): void => {
    // No leaving/locked guard: both disable the button, so no click arrives.
    setLeaving(true)
    setError(null)
    void exitJailbreakMode().then((failure) => {
      if (!aliveRef.current) return
      setLeaving(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setLeaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={css.chip}
        aria-label={t('chip.on.aria')}
        title={t('chip.on.title')}
        disabled={locked || leaving}
        onClick={off}
      >
        {/* Design literal, not copy: the chip wordmark stays 'JB' in every locale. */}
        JB
        <span className={css.close} aria-hidden>
          <IconCloseFill14 size={12} />
        </span>
      </button>
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {error !== null && <span className={css.error} role="status" title={error}>failed to exit jailbreak mode</span>}
    </span>
  )
}
