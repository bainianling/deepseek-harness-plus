/** Dual-model thinking/worker control: trigger chip plus a two-selector panel. */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutline16, IconCheckOutline16, IconWarningOutline16, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelReasoning, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelRolesState } from './roles-directory.ts'
import type { ModelRoles } from './model-roles.ts'
import type { ModelDirectoryState } from './directory.ts'
import css from './ModelRolesControl.module.css'

/** Runtime callbacks bound to one Session's roles directory and shared catalog. */
export interface ModelRolesControlInjected {
  /** Whether this session supports Agent-bound role selection. */
  readonly available: boolean
  /** The session's shared roles store (projection-backed). */
  readonly roles: SnapshotStore<ModelRolesState>
  /** Ensure the shared advisory catalog is loaded (errors land on the store). */
  readonly load: () => void
  /** The session's shared model directory store (catalog + current selection). */
  readonly directory: SnapshotStore<ModelDirectoryState>
  /**
   * Submit a complete roles configuration to the Host.
   * @param value - enabled flag and both exact routes.
   * @returns whether the Host accepted the configuration.
   */
  readonly select: (value: ModelRoles) => Promise<boolean>
}

type ModelRolesControlProps =
  & PropsRuntime<'conversation.input.modelRoles'>
  & ModelRolesControlInjected
  & PropsLocale<'model'>

/** Which route pane the drill-in list shows. */
type RoutePane = 'thinking' | 'worker'
/** What the drilled route pane lists: its models, or the current model's efforts. */
type PaneMode = 'model' | 'effort'

/** Flatten the shared catalog into selectable routes. */
interface RouteChoice {
  readonly id: string
  readonly selection: ModelSelection
  readonly label: string
  readonly detail: string | undefined
  readonly reasoning: ModelReasoning | undefined
}

function choicesOf(directory: SnapshotStore<ModelDirectoryState>): RouteChoice[] {
  const state = directory.getSnapshot()
  const choices: RouteChoice[] = []
  for (const group of state.groups) {
    for (const model of group.models) {
      choices.push({
        id: `${group.id}/${model.id}`,
        selection: {
          provider: group.id,
          model: model.id,
          ...model.reasoning?.defaultEffort === undefined
            ? {}
            : { reasoningEffort: model.reasoning.defaultEffort },
        },
        label: model.name,
        detail: group.name,
        reasoning: model.reasoning,
      })
    }
  }
  return choices
}

function labelOf(choices: readonly RouteChoice[], selection: ModelSelection | undefined): string | undefined {
  if (selection === undefined) return undefined
  return choices.find(choice => choice.selection.provider === selection.provider
    && choice.selection.model === selection.model)?.label
    ?? `${selection.provider}/${selection.model}`
}

/**
 * One effort row: "provider default" (omit the field) plus the model's
 * declared levels, mirroring the model seat's effort list.
 */
interface EffortChoice {
  readonly key: string
  readonly effort: string | undefined
  readonly label: string
}

/**
 * Render the composer dual-model trigger and, while open, the roles panel.
 * @param props - standard session props + injected faces + the locale seat.
 * @returns the trigger chip and, while open, the enable/role panel.
 */
export function ModelRolesControl(
  { locked, available, roles, directory, load, select, t }: ModelRolesControlProps,
) {
  const state = useSyncExternalStore(
    listener => roles.subscribe(listener),
    () => roles.getSnapshot(),
  )
  const choices = useMemo(() => choicesOf(directory), [directory, state.value])
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<RoutePane | null>(null)
  const [paneMode, setPaneMode] = useState<PaneMode>('model')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Load the shared catalog and the projection-backed roles on first open.
  const ensureLoaded = (): void => {
    load()
    void (roles as unknown as { load?: () => Promise<unknown> }).load?.()?.catch(() => { /* surfaced on the store */ })
  }
  useEffect(() => {
    if (open) ensureLoaded()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-gated lazy load
  }, [open])

  // Outside pointer + Escape close, matching the model seat's menu behavior.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
      setPane(null)
      setPaneMode('model')
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (pane !== null && paneMode === 'effort') {
        setPaneMode('model')
        return
      }
      if (pane !== null) {
        setPane(null)
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, pane, paneMode])

  const value = state.value
  const enabled = value?.enabled ?? false
  const thinkingLabel = labelOf(choices, value?.thinking)
  const workerLabel = labelOf(choices, value?.worker)

  const submit = async (next: ModelRoles): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const accepted = await select(next)
      if (!accepted) {
        const message = roles.getSnapshot().error ?? 'rejected'
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text: t('roles.saveFailed', { message }) })
      }
    } finally {
      setSaving(false)
      setPane(null)
      setPaneMode('model')
      setOpen(false)
    }
  }

  // Current route state for the drilled pane.
  const routeSelection = pane === 'thinking' ? value?.thinking : value?.worker
  const paneTitle = pane === 'thinking' ? t('roles.thinking') : t('roles.worker')
  const routeChoice = routeSelection === undefined
    ? undefined
    : choices.find(choice => choice.selection.provider === routeSelection.provider
      && choice.selection.model === routeSelection.model)
  const routeReasoning = routeChoice?.reasoning
  const routeEffectiveEffort = routeSelection?.reasoningEffort ?? routeReasoning?.defaultEffort
  const routeEffortLabel = routeReasoning === undefined
    ? undefined
    : routeEffectiveEffort === undefined
      ? t('effort.providerDefault')
      : routeReasoning.efforts.find(level => level.id === routeEffectiveEffort)?.name ?? routeEffectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => routeReasoning === undefined
    ? []
    : [
      ...routeReasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...routeReasoning.efforts.map(level => ({
        key: `effort:${level.id}`,
        effort: level.id,
        label: level.name,
      })),
    ], [routeReasoning, t])

  const chooseModel = (choice: RouteChoice): void => {
    const base = value ?? fallbackRoles(choices)
    void submit({
      enabled,
      ...(pane === 'thinking'
        ? { thinking: choice.selection, worker: base.worker }
        : { thinking: base.thinking, worker: choice.selection }),
    })
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (routeSelection === undefined) return
    const selection: ModelSelection = {
      provider: routeSelection.provider,
      model: routeSelection.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    const base = value ?? fallbackRoles(choices)
    void submit({
      enabled,
      ...(pane === 'thinking'
        ? { thinking: selection, worker: base.worker }
        : { thinking: base.thinking, worker: selection }),
    })
  }

  if (!available) return null

  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={clsx(css.trigger, enabled && css.triggerActive, locked && css.locked)}
        aria-label={t('roles.triggerAria', { state: enabled ? t('roles.state.enabled') : t('roles.state.disabled') })}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={locked}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { setOpen(openValue => !openValue); setPane(null); setPaneMode('model') }}
      >
        <IconBranchOutline16 size={16} />
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('roles.menu.aria')} ref={panelRef}>
          {pane === null ? (
            <>
              <div className={css.enable}>
                <Switch
                  checked={enabled}
                  onChange={(checked) => { void submit({ ...(value ?? fallbackRoles(choices)), enabled: checked }) }}
                  label={t('roles.enable')}
                  disabled={saving}
                />
                <span className={css.enableLabel}>{t('roles.enable')}</span>
              </div>
              <button
                type="button"
                className={css.cell}
                onClick={() => { setPane('thinking'); setPaneMode('model') }}
              >
                <span className={css.cellLabel}>{t('roles.thinking')}</span>
                <span className={css.cellValue}>{thinkingLabel ?? t('roles.select')}</span>
                <span className={css.cellChevron}>›</span>
              </button>
              <button
                type="button"
                className={css.cell}
                onClick={() => { setPane('worker'); setPaneMode('model') }}
              >
                <span className={css.cellLabel}>{t('roles.worker')}</span>
                <span className={css.cellValue}>{workerLabel ?? t('roles.select')}</span>
                <span className={css.cellChevron}>›</span>
              </button>
            </>
          ) : paneMode === 'model' ? (
            <>
              <button type="button" className={css.back} onClick={() => { setPane(null); setPaneMode('model') }}>
                ‹ {paneTitle}
              </button>
              {routeReasoning !== undefined && (
                <button
                  type="button"
                  className={css.cell}
                  onClick={() => { setPaneMode('effort') }}
                >
                  <span className={css.cellLabel}>{t('roles.effort')}</span>
                  <span className={css.cellValue}>{routeEffortLabel ?? t('effort.providerDefault')}</span>
                  <span className={css.cellChevron}>›</span>
                </button>
              )}
              <div className={css.list}>
                {choices.length === 0 && (
                  <div className={css.empty}>
                    {state.status === 'loading' ? t('roles.loading') : t('roles.empty')}
                  </div>
                )}
                {choices.map(choice => (
                  <button
                    key={choice.id}
                    type="button"
                    className={css.option}
                    disabled={saving}
                    onClick={() => { chooseModel(choice) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{choice.label}</span>
                      {choice.detail !== undefined && <span className={css.modelDetail}>{choice.detail}</span>}
                    </span>
                    <span className={css.check}>
                      {routeSelection !== undefined
                        && routeSelection.provider === choice.selection.provider
                        && routeSelection.model === choice.selection.model
                        ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <button type="button" className={css.back} onClick={() => { setPaneMode('model') }}>
                ‹ {paneTitle} · {t('roles.effort')}
              </button>
              <div className={css.list}>
                {effortChoices.length === 0 && (
                  <div className={css.empty}>{t('empty.efforts')}</div>
                )}
                {effortChoices.map(level => (
                  <button
                    key={level.key}
                    type="button"
                    className={clsx(css.option, routeEffectiveEffort === level.effort && css.selected)}
                    aria-pressed={routeEffectiveEffort === level.effort}
                    disabled={saving}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {routeEffectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {toast !== null && (
        <div className={css.toast} role="alert">
          <IconWarningOutline16 />
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  )
}

/** First-open default before the Host has recorded any roles. */
function fallbackRoles(choices: readonly RouteChoice[]): ModelRoles {
  const fallback = choices[0]?.selection
    ?? { provider: '', model: '' }
  return { enabled: false, thinking: fallback, worker: fallback }
}
