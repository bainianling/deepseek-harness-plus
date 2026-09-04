/** Session-scoped shell workspace over the Host persistent PTY service. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type {
  SessionFace,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  SessionTerminalSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/types'
import {
  IconApiOutline14,
  IconCloseOutline16,
  IconLoadingOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSendOutline16,
  IconStopFill16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './TerminalApp.module.css'

const LIST_POLL_MS = 1_500
const OUTPUT_POLL_MS = 700
const OUTPUT_LINES = 2_000

interface TerminalAppProps {
  session: SessionFace | undefined
  t: AppFrameProps['t']
}

function errorText(result: { ok: false; error: { message: string } }): string {
  return result.error.message
}

/** Full-height terminal workbench for the currently selected Harness Session. */
export function TerminalApp({ session, t }: TerminalAppProps) {
  const [sessions, setSessions] = useState<readonly SessionTerminalSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [output, setOutput] = useState('')
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const outputRef = useRef<HTMLPreElement | null>(null)
  const refreshActive = useRef(false)

  const selected = useMemo(
    () => sessions.find(item => item.sessionId === selectedId),
    [selectedId, sessions],
  )

  const refresh = useCallback(async (showLoading = false) => {
    if (session?.terminalList === undefined || refreshActive.current) return
    refreshActive.current = true
    if (showLoading) setLoading(true)
    try {
      const result = await session.terminalList()
      if (!result.ok) {
        setError(errorText(result))
        return
      }
      setSessions(result.value.sessions)
      setSelectedId((current) => {
        if (current !== undefined && result.value.sessions.some(item => item.sessionId === current)) return current
        return result.value.sessions[0]?.sessionId
      })
      setError(undefined)
    } finally {
      refreshActive.current = false
      if (showLoading) setLoading(false)
    }
  }, [session])

  const readOutput = useCallback(async () => {
    if (session?.terminalRead === undefined || selectedId === undefined) return
    const result = await session.terminalRead(selectedId, 0, OUTPUT_LINES)
    if (!result.ok) {
      setError(errorText(result))
      return
    }
    setOutput(result.value.text)
  }, [selectedId, session])

  useEffect(() => {
    setSessions([])
    setSelectedId(undefined)
    setOutput('')
    setError(undefined)
    if (session === undefined) return
    void refresh(true)
    const timer = window.setInterval(() => { void refresh() }, LIST_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [refresh, session])

  useEffect(() => {
    setOutput('')
    if (session === undefined || selectedId === undefined) return
    void readOutput()
    const timer = window.setInterval(() => { void readOutput() }, OUTPUT_POLL_MS)
    return () => { window.clearInterval(timer) }
  }, [readOutput, selectedId, session])

  useEffect(() => {
    const node = outputRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [output])

  const openTerminal = useCallback(async () => {
    if (session?.terminalOpen === undefined || opening) return
    setOpening(true)
    try {
      const result = await session.terminalOpen(`${t('terminal.shell')} ${String(sessions.length + 1)}`)
      if (!result.ok) {
        setError(errorText(result))
        return
      }
      setSessions(current => [...current, result.value])
      setSelectedId(result.value.sessionId)
      setOutput(result.value.motd)
      setError(undefined)
    } finally {
      setOpening(false)
    }
  }, [opening, session, sessions.length, t])

  const submit = useCallback(async () => {
    const text = command.trim()
    if (session?.terminalSend === undefined || selectedId === undefined || text.length === 0 || sending) return
    setCommand('')
    setHistory(current => [...current.filter(item => item !== text), text].slice(-100))
    setHistoryIndex(0)
    setSending(true)
    setError(undefined)
    try {
      const result = await session.terminalSend(selectedId, text)
      if (!result.ok) setError(errorText(result))
      await Promise.all([refresh(), readOutput()])
    } finally {
      setSending(false)
    }
  }, [command, readOutput, refresh, selectedId, sending, session])

  const stop = useCallback(async () => {
    if (session?.terminalSignal === undefined || selectedId === undefined) return
    const result = await session.terminalSignal(selectedId, 'SIGINT')
    if (!result.ok) setError(errorText(result))
    else setError(undefined)
    await Promise.all([refresh(), readOutput()])
  }, [readOutput, refresh, selectedId, session])

  const close = useCallback(async (terminalSessionId: string) => {
    if (session?.terminalClose === undefined) return
    const result = await session.terminalClose(terminalSessionId)
    if (!result.ok) {
      setError(errorText(result))
      return
    }
    await refresh()
  }, [refresh, session])

  const onCommandKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
      return
    }
    if (event.key === 'ArrowUp' && history.length > 0) {
      event.preventDefault()
      const next = Math.min(history.length, historyIndex + 1)
      setHistoryIndex(next)
      setCommand(history[history.length - next] ?? '')
      return
    }
    if (event.key === 'ArrowDown' && historyIndex > 0) {
      event.preventDefault()
      const next = historyIndex - 1
      setHistoryIndex(next)
      setCommand(next === 0 ? '' : history[history.length - next] ?? '')
    }
  }, [history, historyIndex, submit])

  if (session === undefined) {
    return (
      <section className={css.empty} role="region" aria-label={t('nav.terminal')}>
        <IconApiOutline14 size={34} />
        <h2>{t('terminal.noSession.title')}</h2>
        <p>{t('terminal.noSession.detail')}</p>
      </section>
    )
  }

  return (
    <section className={css.app} role="region" aria-label={t('nav.terminal')}>
      <aside className={css.sidebar}>
        <div className={css.sidebarHeader}>
          <div>
            <span className={css.eyebrow}>{t('terminal.workspace')}</span>
            <h2>{t('terminal.title')}</h2>
          </div>
          <button
            type="button"
            className={css.iconButton}
            onClick={() => { void openTerminal() }}
            disabled={opening}
            title={t('terminal.new')}
            aria-label={t('terminal.new')}
          >
            {opening ? <IconLoadingOutline16 /> : <IconPlusOutline16 />}
          </button>
        </div>
        <div className={css.sessionList}>
          {sessions.map((item, index) => {
            const active = item.sessionId === selectedId
            const running = item.status.kind === 'running'
            return (
              <div key={item.sessionId} className={css.sessionRow} data-active={active || undefined}>
                <button
                  type="button"
                  className={css.sessionSelect}
                  onClick={() => { setSelectedId(item.sessionId) }}
                >
                  <span className={css.statusDot} data-running={running || undefined} data-busy={item.busy || undefined} />
                  <span className={css.sessionText}>
                    <strong>{item.name ?? `${t('terminal.shell')} ${String(index + 1)}`}</strong>
                    <small>{item.pid === undefined ? item.sessionId : `PID ${String(item.pid)}`}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={css.closeButton}
                  onClick={() => { void close(item.sessionId) }}
                  title={t('terminal.close')}
                  aria-label={t('terminal.close')}
                >
                  <IconCloseOutline16 size={14} />
                </button>
              </div>
            )
          })}
          {!loading && sessions.length === 0 && (
            <button type="button" className={css.createEmpty} onClick={() => { void openTerminal() }}>
              <IconPlusOutline16 />
              <span>{t('terminal.createFirst')}</span>
            </button>
          )}
        </div>
        <div className={css.sidebarFooter}>
          <span>{t('terminal.scope')}</span>
          <button
            type="button"
            className={css.iconButton}
            onClick={() => { void refresh(true) }}
            disabled={loading}
            title={t('terminal.refresh')}
            aria-label={t('terminal.refresh')}
          >
            <IconRefreshOutline16 />
          </button>
        </div>
      </aside>

      <div className={css.terminalPane}>
        <header className={css.toolbar}>
          <div className={css.toolbarIdentity}>
            <IconApiOutline14 size={16} />
            <strong>{selected?.name ?? t('terminal.notSelected')}</strong>
            {selected !== undefined && (
              <span className={css.state} data-busy={selected.busy || sending || undefined}>
                {selected.busy || sending ? t('terminal.state.busy') : selected.status.kind === 'running' ? t('terminal.state.ready') : t('terminal.state.exited')}
              </span>
            )}
          </div>
          <button
            type="button"
            className={css.stopButton}
            onClick={() => { void stop() }}
            disabled={selectedId === undefined || selected?.status.kind !== 'running'}
          >
            <IconStopFill16 size={14} />
            <span>{t('terminal.interrupt')}</span>
          </button>
        </header>

        {error !== undefined && <div className={css.error} role="alert">{error}</div>}

        {selectedId === undefined ? (
          <div className={css.outputEmpty}>
            <IconApiOutline14 size={32} />
            <p>{t('terminal.selectOrCreate')}</p>
          </div>
        ) : (
          <pre ref={outputRef} className={css.output} aria-live="polite">{output || t('terminal.waitingOutput')}</pre>
        )}

        <div className={css.composer} data-disabled={selectedId === undefined || undefined}>
          <span className={css.prompt} aria-hidden="true">PS</span>
          <input
            value={command}
            onChange={event => { setCommand(event.target.value); setHistoryIndex(0) }}
            onKeyDown={onCommandKeyDown}
            disabled={selectedId === undefined || selected?.status.kind === 'exited'}
            placeholder={t('terminal.command.placeholder')}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className={css.sendButton}
            onClick={() => { void submit() }}
            disabled={selectedId === undefined || command.trim().length === 0 || sending || selected?.busy}
            title={t('terminal.run')}
            aria-label={t('terminal.run')}
          >
            {sending ? <IconLoadingOutline16 /> : <IconSendOutline16 />}
          </button>
        </div>
      </div>
    </section>
  )
}
