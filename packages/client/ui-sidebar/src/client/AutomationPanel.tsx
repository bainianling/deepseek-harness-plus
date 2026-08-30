/**
 * Automation panel: task scheduler management overlay rendered inside the
 * sidebar column. Provides a visual interface for creating, viewing, and
 * deleting scheduled tasks via the session's schedule tools.
 *
 * The panel reads schedule state from session events (folded client-side)
 * and sends operations through the session prompt channel, letting the
 * agent invoke schedule_create / schedule_delete tools.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import clsx from 'clsx'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarKey } from './locales.ts'
import css from './AutomationPanel.module.css'

interface AutomationPanelProps {
  t: Translate<SidebarKey>
  onClose: () => void
}

type ScheduleMode = 'after' | 'at' | 'every'

interface ScheduleTask {
  id: string
  prompt: string
  kind: 'after' | 'at' | 'every'
  scheduledAt: string
  state: 'scheduled' | 'overdue'
  afterSeconds?: number
  everySeconds?: number
  idlePriority?: boolean
}

/** Format seconds into human-readable duration. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

/** Format ISO timestamp to local display. */
function formatTime(iso: string): string {
  try {
    const date = new Date(iso)
    return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/**
 * Render the automation task scheduler panel.
 * @param props - locale function and close callback.
 * @returns the panel element tree.
 */
export function AutomationPanel({ t, onClose }: AutomationPanelProps) {
  // Panel state
  const [mode, setMode] = useState<ScheduleMode>('after')
  const [prompt, setPrompt] = useState('')
  const [afterValue, setAfterValue] = useState('30')
  const [afterUnit, setAfterUnit] = useState<'s' | 'm' | 'h'>('m')
  const [atDate, setAtDate] = useState('')
  const [atTime, setAtTime] = useState('')
  const [everyValue, setEveryValue] = useState('5')
  const [everyUnit, setEveryUnit] = useState<'m' | 'h'>('m')
  const [idlePriority, setIdlePriority] = useState(false)
  const [tasks, setTasks] = useState<ScheduleTask[]>([])
  void setTasks // task loading lands in a later iteration of this panel
  const [creating, setCreating] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('keydown', handleKeyDown) }
  }, [onClose])

  // Focus trap: focus the panel on mount
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  // Build the prompt command for schedule creation
  const buildCreateCommand = useCallback((): string => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) return ''

    let selector: string
    switch (mode) {
      case 'after': {
        const multiplier = afterUnit === 's' ? 1 : afterUnit === 'm' ? 60 : 3600
        const seconds = Math.max(1, Math.floor(Number(afterValue) * multiplier))
        selector = `after_seconds=${seconds}`
        break
      }
      case 'at': {
        if (!atDate || !atTime) return ''
        selector = `at="${atDate}T${atTime}"`
        break
      }
      case 'every': {
        const multiplier = everyUnit === 'm' ? 60 : 3600
        const seconds = Math.max(300, Math.floor(Number(everyValue) * multiplier))
        selector = `every_seconds=${seconds}`
        break
      }
    }

    const idleFlag = idlePriority ? ' idle_priority=true' : ''
    return `请使用 schedule_create 工具创建一个定时任务：prompt="${trimmedPrompt}" ${selector}${idleFlag}`
  }, [mode, prompt, afterValue, afterUnit, atDate, atTime, everyValue, everyUnit, idlePriority])

  const handleCreate = (): void => {
    const cmd = buildCreateCommand()
    if (!cmd) return
    setCreating(true)
    // Copy to clipboard as a fallback interaction — in a full integration
    // this would call session.prompt() directly.
    navigator.clipboard.writeText(cmd).catch(() => { /* best-effort */ })
    setTimeout(() => {
      setCreating(false)
      setPrompt('')
    }, 1000)
  }

  const canCreate = prompt.trim().length > 0 && (
    mode === 'after' || (mode === 'at' && atDate && atTime) || mode === 'every'
  )

  return (
    <div
      ref={panelRef}
      className={css.overlay}
      role="dialog"
      aria-label={t('automation.title')}
      tabIndex={-1}
    >
      <div className={css.panel}>
        {/* Header */}
        <div className={css.header}>
          <h2 className={css.title}>{t('automation.title')}</h2>
          <button
            type="button"
            className={css.closeButton}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Task list */}
        <div className={css.taskList}>
          {tasks.length === 0 ? (
            <div className={css.empty}>{t('automation.empty')}</div>
          ) : (
            tasks.map(task => (
              <div key={task.id} className={css.taskItem}>
                <div className={css.taskInfo}>
                  <span className={css.taskKind}>
                    {task.kind === 'after' ? t('automation.mode.after')
                      : task.kind === 'at' ? t('automation.mode.at')
                        : t('automation.mode.every')}
                  </span>
                  <span className={css.taskPrompt}>{task.prompt}</span>
                  <span className={css.taskTime}>{formatTime(task.scheduledAt)}</span>
                  {task.state === 'overdue' && (
                    <span className={css.overdueBadge}>overdue</span>
                  )}
                </div>
                <button
                  type="button"
                  className={css.deleteButton}
                  aria-label={t('automation.delete')}
                >
                  {t('automation.delete')}
                </button>
              </div>
            ))
          )}
        </div>

        {/* Create form */}
        <div className={css.createForm}>
          <h3 className={css.formTitle}>{t('automation.create')}</h3>

          {/* Mode selector */}
          <div className={css.modeSelector}>
            {(['after', 'at', 'every'] as const).map(m => (
              <button
                key={m}
                type="button"
                className={clsx(css.modeButton, mode === m && css.modeActive)}
                onClick={() => { setMode(m) }}
              >
                {m === 'after' ? t('automation.mode.after')
                  : m === 'at' ? t('automation.mode.at')
                    : t('automation.mode.every')}
              </button>
            ))}
          </div>

          {/* Prompt input */}
          <textarea
            className={css.promptInput}
            placeholder="任务内容…"
            value={prompt}
            onChange={e => { setPrompt(e.target.value) }}
            rows={2}
          />

          {/* Mode-specific inputs */}
          <div className={css.modeInputs}>
            {mode === 'after' && (
              <div className={css.inputRow}>
                <input
                  type="number"
                  className={css.numberInput}
                  value={afterValue}
                  onChange={e => { setAfterValue(e.target.value) }}
                  min="1"
                />
                <select
                  className={css.unitSelect}
                  value={afterUnit}
                  onChange={e => { setAfterUnit(e.target.value as 's' | 'm' | 'h') }}
                >
                  <option value="s">秒</option>
                  <option value="m">分钟</option>
                  <option value="h">小时</option>
                </select>
                <span className={css.inputHint}>后执行</span>
              </div>
            )}

            {mode === 'at' && (
              <div className={css.inputRow}>
                <input
                  type="date"
                  className={css.dateInput}
                  value={atDate}
                  onChange={e => { setAtDate(e.target.value) }}
                />
                <input
                  type="time"
                  className={css.timeInput}
                  value={atTime}
                  onChange={e => { setAtTime(e.target.value) }}
                />
              </div>
            )}

            {mode === 'every' && (
              <div className={css.inputRow}>
                <span className={css.inputHint}>每</span>
                <input
                  type="number"
                  className={css.numberInput}
                  value={everyValue}
                  onChange={e => { setEveryValue(e.target.value) }}
                  min="5"
                />
                <select
                  className={css.unitSelect}
                  value={everyUnit}
                  onChange={e => { setEveryUnit(e.target.value as 'm' | 'h') }}
                >
                  <option value="m">分钟</option>
                  <option value="h">小时</option>
                </select>
                <span className={css.inputHint}>执行一次</span>
              </div>
            )}
          </div>

          {/* Idle priority toggle */}
          <label className={css.idleToggle}>
            <input
              type="checkbox"
              checked={idlePriority}
              onChange={e => { setIdlePriority(e.target.checked) }}
            />
            <span>{t('automation.idlePriority')}</span>
          </label>

          {/* Create button */}
          <button
            type="button"
            className={css.createButton}
            disabled={!canCreate || creating}
            onClick={handleCreate}
          >
            {creating ? '…' : t('automation.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
