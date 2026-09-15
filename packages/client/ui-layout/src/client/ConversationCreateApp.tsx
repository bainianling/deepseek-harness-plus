/**
 * 「对话创造」 pane: author a full conversation context, validate it, pick a
 * group, and create it as an ordinary real Session.
 *
 * The pane is pure UI over two real inputs: the injected `createConversation`
 * capability (built in the layout plugin's apply over the live Session
 * Controller) and the framework's `useWorkspaces` group feed. It never
 * fabricates conversation content and never fakes success — creation runs the
 * real chain in {@link createConversationCreator} and every failure is shown
 * with its stage, its original message, and the created Session id when one
 * already exists (so a partial creation is diagnosable, not hidden).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconEditOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { AppFrameProps } from './AppFrame.tsx'
import {
  makeEntry, planTurns, starterDraft, validateDraft,
  type DraftEntry, type DraftEntryKind, type DraftIssueCode,
} from './conversation-create.ts'
import type { CreationOptions } from './conversation-creator.ts'
import { ConversationCreateError } from './conversation-creator.ts'
import css from './ConversationCreateApp.module.css'

/** Kinds offered in the entry-kind selector, in authoring order. */
const KIND_ORDER: readonly DraftEntryKind[] = ['user', 'assistant', 'tool-call', 'tool-result']

/** Kinds whose entry owns a tool-call identity field. */
function hasCallId(kind: DraftEntryKind): boolean {
  return kind === 'tool-call' || kind === 'tool-result'
}

/** Localize one issue code into an actionable line. */
function issueText(issueCode: DraftIssueCode, t: AppFrameProps['t']): string {
  return t(`convCreate.issue.${issueCode}`)
}

interface Props {
  /** Injected real-creation capability from the layout plugin's apply. */
  createConversation: AppFrameProps['createConversation']
  /** Group feed: the same Workspace rows the workspace browser lists. */
  useWorkspaces: AppFrameProps['useWorkspaces']
  t: AppFrameProps['t']
}

/** Progress line state while a creation runs. */
interface Running {
  readonly sessionId: SessionId
  readonly completed: number
  readonly total: number
}

export function ConversationCreateApp({ createConversation, useWorkspaces, t }: Props) {
  const [entries, setEntries] = useState<readonly DraftEntry[]>(() => starterDraft(t))
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId | ''>('')
  const [presetId, setPresetId] = useState('')
  const [routeKey, setRouteKey] = useState('')
  const [options, setOptions] = useState<CreationOptions>()
  const [optionsError, setOptionsError] = useState<string>()
  const [running, setRunning] = useState<Running>()
  const [created, setCreated] = useState<SessionId>()
  const [failure, setFailure] = useState<ConversationCreateError>()
  const [showPreview, setShowPreview] = useState(false)
  const abort = useRef<AbortController | null>(null)

  // Group options come from the real Workspace registry; the selector states
  // its own empty case rather than inventing a group.
  const workspaces = useWorkspaces(snapshot => snapshot.items)
  const phase = useWorkspaces(snapshot => snapshot.phase)
  const issues = useMemo(() => validateDraft(entries), [entries])
  const plan = useMemo(() => (issues.length === 0 ? planTurns(entries) : []), [entries, issues])
  const busy = running !== undefined

  // Preset and model choices are read from the Host, not hard-coded: what the
  // selectors list is exactly what a session can really run. A failed read is
  // reported in place and leaves the deployment default selectable.
  useEffect(() => {
    let active = true
    void createConversation.listOptions()
      .then((loaded) => {
        if (!active) return
        setOptions(loaded)
        setOptionsError(undefined)
      })
      .catch((error: unknown) => {
        if (!active) return
        setOptionsError(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [createConversation])

  // Model options are one flat list keyed "provider\u0000model" so a single
  // select can express both halves of the route the Host needs.
  const modelOptions = useMemo(() => {
    if (options === undefined) return []
    return options.providers.flatMap(group => group.models.map(model => ({
      key: `${group.id}\u0000${model.id}`,
      label: `${group.label} · ${model.label}`,
      provider: group.id,
      model: model.id,
      routable: options.routableProviders.includes(group.id),
    })))
  }, [options])

  const patch = useCallback((id: string, changes: Partial<DraftEntry>) => {
    setEntries(current => current.map(entry => (entry.id === id ? { ...entry, ...changes } : entry)))
  }, [])
  const insertAfter = useCallback((index: number, kind: DraftEntryKind) => {
    setEntries(current => {
      const next = [...current]
      next.splice(index + 1, 0, makeEntry(kind))
      return next
    })
  }, [])
  const removeAt = useCallback((index: number) => {
    setEntries(current => current.filter((_, offset) => offset !== index))
  }, [])
  const move = useCallback((index: number, delta: number) => {
    setEntries((current) => {
      const target = index + delta
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      if (moved === undefined) return current
      next.splice(target, 0, moved)
      return next
    })
  }, [])

  const create = useCallback(async () => {
    if (workspaceId === '') {
      setFailure(new ConversationCreateError('validate', t('convCreate.error.groupRequired')))
      return
    }
    const controller = new AbortController()
    abort.current = controller
    setFailure(undefined)
    setCreated(undefined)
    // Only the choices the user actually made are sent; an unset picker means
    // "keep the deployment default" rather than a client-side guess.
    const chosenModel = modelOptions.find(option => option.key === routeKey)
    try {
      // Real chain: Host Session → durable events → real model turns.
      const sessionId = await createConversation.create({
        workspaceId,
        turns: plan,
        title: t('convCreate.sessionTitle'),
        composition: {
          ...presetId === '' ? {} : { agentPreset: presetId },
          ...chosenModel === undefined
            ? {}
            : { model: { provider: chosenModel.provider, model: chosenModel.model } },
        },
        signal: controller.signal,
        onProgress: (progress) => { setRunning(progress) },
      })
      setCreated(sessionId)
    } catch (error) {
      // Every failure surfaces its real stage and message; nothing is retried
      // silently and no success is reported for a failed run.
      setFailure(error instanceof ConversationCreateError
        ? error
        : new ConversationCreateError('create', String(error)))
    } finally {
      abort.current = null
      setRunning(undefined)
    }
  }, [createConversation, modelOptions, plan, presetId, routeKey, t, workspaceId])

  const entryTitle = useCallback((index: number): string => {
    const entry = entries[index]
    return entry === undefined ? '' : `${t('convCreate.entry')} ${String(index + 1)} · ${t(`convCreate.kind.${entry.kind}`)}`
  }, [entries, t])

  return (
    <div className={css.pane} role="region" aria-label={t('nav.conversationCreate')}>
      <div className={css.column}>
        <header className={css.header}>
          <div className={css.headerIcon} aria-hidden="true"><IconEditOutline16 size={22} /></div>
          <div className={css.headerText}>
            <h2 className={css.title}>{t('nav.conversationCreate')}</h2>
            <p className={css.subtitle}>{t('convCreate.subtitle')}</p>
          </div>
          <div className={css.headerActions}>
            <button type="button" className={css.ghostButton} onClick={() => { setEntries(starterDraft(t)) }}>
              <IconRefreshOutline16 size={14} />
              {t('convCreate.reset')}
            </button>
            <button
              type="button"
              className={css.ghostButton}
              aria-pressed={showPreview}
              onClick={() => { setShowPreview(value => !value) }}
            >
              {showPreview ? t('convCreate.edit') : t('convCreate.preview')}
            </button>
          </div>
        </header>

        {failure !== undefined && (
          <div className={css.errorBar} role="alert">
            <strong>{t(`convCreate.stage.${failure.stage}`)}</strong>
            <span>{failure.detail}</span>
            {failure.sessionId !== undefined && (
              <span className={css.errorSession}>{t('convCreate.error.session')}: {failure.sessionId}</span>
            )}
            {failure.turn !== undefined && (
              <span className={css.errorSession}>{t('convCreate.error.turn')}: {failure.turn}</span>
            )}
          </div>
        )}

        {created !== undefined && (
          <div className={css.successBar} role="status">
            {t('convCreate.created')}: <code>{created}</code>
          </div>
        )}

        {running !== undefined && (
          <div className={css.progressBar} role="status">
            {t('convCreate.progress')
              .replace('{done}', String(running.completed))
              .replace('{total}', String(running.total))}
          </div>
        )}

        {showPreview
          ? <Preview entries={entries} t={t} />
          : (
            <ol className={css.entryList}>
              {entries.map((entry, index) => (
                <li key={entry.id} className={css.entry} data-kind={entry.kind}>
                  <div className={css.entryHead}>
                    <span className={css.entryIndex}>{index + 1}</span>
                    <select
                      className={css.kindSelect}
                      value={entry.kind}
                      aria-label={t('convCreate.field.kind')}
                      onChange={(event) => {
                        patch(entry.id, { kind: event.target.value as DraftEntryKind })
                      }}
                    >
                      {KIND_ORDER.map(kind => (
                        <option key={kind} value={kind}>{t(`convCreate.kind.${kind}`)}</option>
                      ))}
                    </select>
                    <span className={css.entrySpacer} />
                    <button type="button" className={css.iconButton} disabled={index === 0}
                      aria-label={t('convCreate.moveUp')} title={t('convCreate.moveUp')}
                      onClick={() => { move(index, -1) }}>↑</button>
                    <button type="button" className={css.iconButton} disabled={index === entries.length - 1}
                      aria-label={t('convCreate.moveDown')} title={t('convCreate.moveDown')}
                      onClick={() => { move(index, 1) }}>↓</button>
                    <button type="button" className={css.iconButton}
                      aria-label={t('delete')} title={t('delete')}
                      onClick={() => { removeAt(index) }}><IconTrashOutline16 size={14} /></button>
                  </div>

                  {entry.kind === 'tool-call' && (
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('convCreate.field.toolName')}</span>
                      <input
                        className={css.input}
                        value={entry.text}
                        placeholder={t('convCreate.placeholder.toolName')}
                        onChange={(event) => { patch(entry.id, { text: event.target.value }) }}
                      />
                    </label>
                  )}
                  {hasCallId(entry.kind) && (
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('convCreate.field.callId')}</span>
                      <input
                        className={css.input}
                        value={entry.callId}
                        placeholder={t('convCreate.placeholder.callId')}
                        onChange={(event) => { patch(entry.id, { callId: event.target.value }) }}
                      />
                    </label>
                  )}
                  {entry.kind === 'tool-call' && (
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('convCreate.field.arguments')}</span>
                      <textarea
                        className={css.textarea}
                        rows={2}
                        value={entry.arguments}
                        placeholder={t('convCreate.placeholder.arguments')}
                        onChange={(event) => { patch(entry.id, { arguments: event.target.value }) }}
                      />
                    </label>
                  )}
                  {entry.kind !== 'tool-call' && (
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('convCreate.field.text')}</span>
                      <textarea
                        className={css.textarea}
                        rows={entry.kind === 'user' ? 3 : 2}
                        value={entry.text}
                        placeholder={t('convCreate.placeholder.text')}
                        onChange={(event) => { patch(entry.id, { text: event.target.value }) }}
                      />
                    </label>
                  )}

                  <div className={css.insertRow}>
                    {KIND_ORDER.map(kind => (
                      <button key={kind} type="button" className={css.insertButton}
                        onClick={() => { insertAfter(index, kind) }}>
                        <IconPlusOutline16 size={12} />
                        {t(`convCreate.insert.${kind}`)}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          )}

        {issues.length > 0 && (
          <div className={css.issueList} role="alert">
            <div className={css.issueTitle}>{t('convCreate.issues')}</div>
            <ul>
              {issues.map((issue, offset) => (
                <li key={`${issue.code}-${String(issue.index)}-${String(offset)}`}>
                  {issue.index < 0 ? t('convCreate.whole') : entryTitle(issue.index)}
                  {' — '}
                  {issueText(issue.code, t)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <footer className={css.createBar}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('convCreate.group')}</span>
            <select
              className={css.kindSelect}
              value={workspaceId}
              disabled={busy}
              onChange={(event) => { setWorkspaceId(event.target.value as WorkspaceId | '') }}
            >
              <option value="">{t('convCreate.group.placeholder')}</option>
              {/* Group options read from the real Workspace registry. */}
              {workspaces.map(item => (
                <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>
              ))}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('convCreate.preset')}</span>
            <select
              className={css.kindSelect}
              value={presetId}
              disabled={busy}
              onChange={(event) => { setPresetId(event.target.value) }}
            >
              <option value="">{t('convCreate.preset.default')}</option>
              {(options?.presets ?? []).map(preset => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}{preset.isDefault ? '*' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('convCreate.model')}</span>
            <select
              className={css.kindSelect}
              value={routeKey}
              disabled={busy}
              onChange={(event) => { setRouteKey(event.target.value) }}
            >
              <option value="">{t('convCreate.model.default')}</option>
              {modelOptions.map(option => (
                <option key={option.key} value={option.key}>
                  {option.label}{option.routable ? '' : t('convCreate.model.unroutable')}
                </option>
              ))}
            </select>
          </label>
          {phase === 'ready' && workspaces.length === 0 && (
            <p className={css.groupEmpty}>{t('convCreate.group.empty')}</p>
          )}
          {/* An unavailable list states itself instead of rendering an empty
              select that would read as "nothing to choose". */}
          {options !== undefined && options.presets.length === 0 && (
            <p className={css.groupEmpty}>{t('convCreate.preset.empty')}</p>
          )}
          {options !== undefined && modelOptions.length === 0 && (
            <p className={css.groupEmpty}>{t('convCreate.model.empty')}</p>
          )}
          {optionsError !== undefined && (
            <p className={css.groupEmpty}>{t('convCreate.options.failed')} {optionsError}</p>
          )}
          {options !== undefined && options.failures.length > 0 && (
            <p className={css.groupEmpty}>
              {t('convCreate.options.failed')} {options.failures.join('; ')}
            </p>
          )}
          <span className={css.entrySpacer} />
          <span className={css.planSummary}>
            {t('convCreate.plan')
              .replace('{turns}', String(plan.length))
              .replace('{entries}', String(entries.length))}
          </span>
          <button
            type="button"
            className={css.primaryButton}
            disabled={busy || issues.length > 0 || workspaceId === ''}
            onClick={() => { void create() }}
          >
            {busy ? t('submitting') : t('convCreate.submit')}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Preview: the drafted context in the conversation surface's own visual shape. */
function Preview({ entries, t }: { entries: readonly DraftEntry[]; t: AppFrameProps['t'] }) {
  return (
    <div className={css.preview}>
      {entries.map((entry, index) => (
        <div key={entry.id} className={css.previewRow} data-kind={entry.kind}>
          <div className={css.previewAvatar} aria-hidden="true">
            {t(`convCreate.avatar.${entry.kind}`)}
          </div>
          <div className={css.previewBody}>
            <div className={css.previewMeta}>
              {t(`convCreate.kind.${entry.kind}`)}
              <span className={css.previewIndex}>#{index + 1}</span>
            </div>
            {entry.kind === 'tool-call'
              ? (
                <div className={css.toolBlock}>
                  <div className={css.toolName}>{entry.text}</div>
                  <pre className={css.toolArgs}>{entry.arguments}</pre>
                  <div className={css.toolCallId}>{entry.callId}</div>
                </div>
              )
              : (
                <div className={entry.kind === 'tool-result' ? css.toolResult : css.previewText}>
                  {entry.text}
                </div>
              )}
          </div>
        </div>
      ))}
    </div>
  )
}
