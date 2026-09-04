/**
 * The session header's agent-preset control.
 *
 * The host recomposes an agent between turns — blank, idle, and finished
 * sessions all accept a swap, while a turn still running locks it. That makes
 * the header the honest place for the choice itself: the control names what
 * the session runs now and offers the rest of the roster; picking one commits
 * through `agentPreset.select` and the logged selection is what resume
 * rebuilds from.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutline16, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentPresetLabel.module.css'

/** Registration-side business face for the header control. */
export interface AgentPresetLabelInjected {
  hooks: {
    /** Roster snapshot bound by the renderer as useAgentPresets. */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  /** Read the roster, so the control can show a name rather than an id. */
  load: () => Promise<void>
  /**
   * Commit one preset onto this session's agent (`agentPreset.select`).
   * Rejects with the host's message when the session is mid-turn or the
   * preset cannot compose.
   */
  switchPreset: (sessionId: string, agentPreset: string) => Promise<void>
}

/** Full component props. */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/**
 * Render this session's agent-preset picker beside its title.
 * @param props - composed slot props.
 * @returns the control, or null when the deployment composes no presets.
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresets, load, switchPreset, t,
}: AgentPresetLabelProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const running = useSessions(state => state.byId[sessionId]?.running ?? false)
  const options = useAgentPresets(state => state.options)

  useEffect(() => {
    // One roster request per mounted header; every surface reads the same
    // store, so later mounts converge on the cached rows.
    void load()
  }, [load])

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Nothing to choose between AND nothing recorded: the deployment composes
  // no presets and every session shares the host composition.
  if (options.length === 0 && preset === undefined) return null

  const option = options.find(entry => entry.id === preset)
  const text = option === undefined ? undefined : presetDisplayText(option, t)

  const pick = (id: string): void => {
    if (busy || id === preset) return
    setBusy(true)
    setError(null)
    switchPreset(sessionId as string, id).then(() => {
      setBusy(false)
    }).catch((reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={options.map((entry) => {
        const entryText = presetDisplayText(entry, t)
        return {
          id: entry.id,
          label: entry.trust === 'user' ? `${entryText.name} · ${t('userTrust')}` : entryText.name,
        }
      })}
      selectedId={preset ?? ''}
      onSelect={(id) => {
        setOpen(false)
        pick(id)
      }}
      align="start"
      portal
      anchor={(
        <button
          type="button"
          className={css.label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={busy}
          title={error ?? (running ? t('switchLockedHint') : t('headerHint'))}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconAgentPresetOutline16 size={14} className={css.icon} />
          {text?.name ?? t('headerDefault')}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      )}
    />
  )
}
