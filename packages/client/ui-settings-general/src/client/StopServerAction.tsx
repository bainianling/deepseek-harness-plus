/**
 * Sidebar footer action above the settings trigger: stops the harness server.
 * A two-stage click guards the destructive request (the first click arms a
 * short confirm window; the second inside it fires the POST). The Host acks
 * before its teardown begins, so the row holds its stopping state until the
 * connection drops and the shell's own offline handling takes over.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconStopFill16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StopServerAction.module.css'

/** How long the armed confirm state waits for the second click. */
const CONFIRM_RESET_MS = 3000

/** Full sidebar footer-action props (the column display state + copy). */
export type StopServerActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'settings'>

/** Interaction phases of the stop control. */
type Phase = 'idle' | 'confirm' | 'stopping'

/**
 * Render the server-stop control (icon + label in the wide column, icon only
 * in the rail).
 * @param props - composed slot props.
 * @returns the stop control element tree.
 */
export function StopServerAction({ wide, t }: StopServerActionProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const confirmTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { window.clearTimeout(confirmTimer.current) }, [])

  const onClick = useCallback(() => {
    if (phase === 'stopping') return
    if (phase !== 'confirm') {
      setPhase('confirm')
      window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => { setPhase('idle') }, CONFIRM_RESET_MS)
      return
    }
    window.clearTimeout(confirmTimer.current)
    setPhase('stopping')
    void fetch('/server/shutdown', { method: 'POST', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status))
        // Acked: keep the stopping state; the Host disposes behind the response.
      })
      .catch(() => {
        // The request failed before teardown — restore the control. The
        // socket may still drop if the failure raced the shutdown.
        setPhase('idle')
      })
  }, [phase])

  const label = phase === 'stopping' ? t('stopServer.stopping') : t('stopServer')

  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <button
        type="button"
        className={wide ? css.root : `${css.root} ${css.rail}`}
        data-phase={phase}
        disabled={phase === 'stopping'}
        aria-label={t('stopServer')}
        onClick={onClick}
      >
        <IconStopFill16 size={wide ? 16 : 18} />
        {wide && <span className={css.label}>{phase === 'confirm' ? t('stopServer.confirm') : label}</span>}
      </button>
    </Tooltip>
  )
}
