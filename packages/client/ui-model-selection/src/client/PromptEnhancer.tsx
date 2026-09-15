/** Composer control that asks the selected model to rewrite the current draft. */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconSparkle16, Switch, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  PromptEnhancementRequest, PromptEnhancementValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelDirectoryState } from './directory.ts'
import css from './PromptEnhancer.module.css'

/** Runtime callbacks bound to one Session's model directory and Remote face. */
export interface PromptEnhancerInjected {
  /** Whether this session supports Agent-bound prompt enhancement. */
  readonly available: boolean
  /** The session's shared directory store (same instance the model seat reads). */
  readonly directory: SnapshotStore<ModelDirectoryState>
  /**
   * Rewrite the draft with the exact model reported by the directory's
   * `current`. The request must carry that exact selection; the Host rejects
   * anything else as stale.
   */
  readonly enhance: (
    request: PromptEnhancementRequest,
    signal?: AbortSignal,
  ) => Promise<RemoteResult<PromptEnhancementValue>>
}

/**
 * Standard-session props the component consumes. The slot machinery delivers
 * the full standard share; like ModelSelect, the declaration names only the
 * members it reads so tests can stub exactly those.
 */
export interface PromptEnhancerProps {
  /** Selector hook over the Session input machine. */
  useInput: SnapshotSelectorHook<InputState>
  /** Stable public input actions for this Session. */
  inputActions: Pick<InputActions, 'setDraft'>
  /** Selector hook over the Session lifecycle state. */
  useSession: SnapshotSelectorHook<SessionSnapshot>
  /** Current Session identity (echoed verbatim into the Host request). */
  sessionId: PromptEnhancementRequest['sessionId']
}

type PromptEnhancerAllProps = PromptEnhancerProps & PromptEnhancerInjected & PropsLocale<'model'>

/** Inert input state used before the input machine publishes its first snapshot. */
const EMPTY_INPUT: InputState = {
  draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [],
}

/**
 * Render the composer's prompt-enhancement entry.
 * @param props - standard session props (input hooks and actions) + the
 * injected directory/Remote face + the shared locale seat.
 * @returns the tool-row chip and, while open, the option panel.
 */
export function PromptEnhancer(
  { useInput, inputActions, useSession, sessionId, available, directory, enhance, t }:
  PromptEnhancerAllProps,
) {
  const input = useInput(state => state.draft === undefined ? EMPTY_INPUT : state)
  const model = useSyncExternalStore(
    listener => directory.subscribe(listener),
    () => directory.getSnapshot(),
  )
  const session = useSession(state => state)
  const [open, setOpen] = useState(false)
  const [readProject, setReadProject] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The draft immediately before the latest accepted rewrite; the one-step
  // revert lives only in this component, never in durable state.
  const [original, setOriginal] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const selected = model.current
  const disabled = !available || session.removed || input.phase !== 'plain' || selected === null
  const run = (): void => {
    if (pending || disabled) return
    const prompt = input.draft.trim()
    if (prompt.length === 0) {
      setError(t('enhancer.emptyPrompt'))
      setOpen(true)
      return
    }
    const selection = selected
    if (selection === null) return
    setPending(true)
    setError(null)
    const request: PromptEnhancementRequest = {
      sessionId,
      prompt,
      readProject,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
    void enhance(request).then((result) => {
      if (!mounted.current) return
      if (!result.ok) {
        setError(`${result.error.message} (${result.error.code})`)
        return
      }
      setOriginal(input.draft)
      inputActions.setDraft(result.value.prompt)
      setError(null)
    }).catch((cause: unknown) => {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      if (mounted.current) setPending(false)
    })
  }

  const revert = (): void => {
    if (original === null) return
    inputActions.setDraft(original)
    setOriginal(null)
    setError(null)
  }

  if (!available) return null

  return (
    <div className={css.root}>
      <Tooltip label={pending ? t('enhancer.enhancing') : t('enhancer.button')} side="top" delayMs={500}>
        <button
          type="button"
          className={css.trigger}
          aria-label={pending ? t('enhancer.enhancing') : t('enhancer.button')}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled || pending}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={() => { setOpen(value => !value); setError(null) }}
        >
          <IconSparkle16 size={14} />
          <span className={css.triggerLabel}>{t('enhancer.shortButton')}</span>
        </button>
      </Tooltip>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('enhancer.panel')}>
          <div className={css.panelTitle}>{t('enhancer.panel')}</div>
          <div className={css.option}>
            <Switch
              checked={readProject}
              onChange={setReadProject}
              label={t('enhancer.readProject')}
              disabled={pending}
            />
            <span className={css.optionCopy}>{t('enhancer.readProject')}</span>
          </div>
          <div className={css.actions}>
            <button
              type="button"
              className={css.run}
              disabled={disabled || pending}
              onClick={run}
            >
              <IconSparkle16 size={13} />
              <span>{pending ? t('enhancer.enhancing') : t('enhancer.run')}</span>
            </button>
            {original !== null && (
              <button type="button" className={css.revert} disabled={pending} onClick={revert}>
                {t('enhancer.revert')}
              </button>
            )}
          </div>
          {error !== null && <div className={css.error} role="alert">{error}</div>}
        </div>
      )}
    </div>
  )
}
