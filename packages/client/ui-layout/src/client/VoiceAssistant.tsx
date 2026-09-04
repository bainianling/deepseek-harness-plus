/**
 * Voice clone AI assistant: a floating chat-only window (no sidebar) over the
 * voice studio. Talks to the voice service's /api/voice/assistant streaming
 * endpoint (same LLM brain as the harness, scoped by an expert system prompt
 * that already knows the whole IndexTTS-2.5 parameter structure, so a fresh
 * session never re-discovers it). Assistant replies may carry ```voice-params
 * JSON blocks; each renders a one-click "apply to studio" button that writes
 * the suggested values into the workbench form.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconCheckOutline14, IconCloseOutline16, IconLoadingOutline16, IconSendOutline16,
  IconSparkle16, IconStopFill16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './VoiceAssistant.module.css'

/** One chat message in the assistant window. */
interface AssistantMsg {
  role: 'user' | 'assistant'
  content: string
}

/** Partial parameter set the AI may suggest (mirrors the studio form). */
export interface VoiceAssistantParams {
  text?: string
  lang?: string
  emo_mode?: number
  emo_alpha?: number
  emo_vector?: number[]
  emo_text?: string
  use_random?: boolean
  duration_factor?: number
  interval_silence?: number
  text_normalization?: boolean
  advanced?: Record<string, number | boolean>
}

export interface VoiceAssistantProps {
  t: AppFrameProps['t']
  serviceUrl: string
  available: boolean
  onClose: () => void
  /** Live form snapshot injected into the assistant's context each turn. */
  getFormSnapshot: () => Record<string, unknown>
  /** Applies one parsed voice-params block to the studio form. */
  applyParams: (params: VoiceAssistantParams) => void
}

const HISTORY_KEY = 'dsh.voiceAssistant.history'
const MAX_HISTORY = 40

/** Quick-start prompts so the user never types the structure questions. */
const QUICK_PROMPT_KEYS = [
  'voice.assistant.q1', 'voice.assistant.q2', 'voice.assistant.q3',
  'voice.assistant.q4', 'voice.assistant.q5', 'voice.assistant.q6',
] as const

function readHistory(): AssistantMsg[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as AssistantMsg[]
      if (Array.isArray(parsed)) return parsed.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-MAX_HISTORY)
    }
  } catch { /* corrupted storage — start fresh */ }
  return []
}

/** Split a message into text / code-fence segments for rendering. */
function splitSegments(content: string): Array<{ kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string }> {
  const segments: Array<{ kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string }> = []
  const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fence.exec(content)) !== null) {
    if (match.index > last) segments.push({ kind: 'text', text: content.slice(last, match.index) })
    segments.push({ kind: 'code', lang: (match[1] ?? '').trim(), code: match[2] ?? '' })
    last = match.index + match[0].length
  }
  if (last < content.length) segments.push({ kind: 'text', text: content.slice(last) })
  return segments
}

export function VoiceAssistantApp({ t, serviceUrl, available, onClose, getFormSnapshot, applyParams }: VoiceAssistantProps) {
  const [messages, setMessages] = useState<AssistantMsg[]>(readHistory)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [appliedMarks, setAppliedMarks] = useState<Set<number>>(new Set())
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-MAX_HISTORY))) } catch { /* non-fatal */ }
  }, [messages])

  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messages, streamText])

  /** One SSE round-trip against the assistant endpoint. */
  const send = useCallback(async (userText: string) => {
    const text = userText.trim()
    if (text === '' || streaming) return
    setError(null)
    const history = [...messages, { role: 'user' as const, content: text }]
    setMessages(history)
    setInput('')
    setStreaming(true)
    setStreamText('')
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++seqRef.current
    let acc = ''
    try {
      const response = await fetch(`${serviceUrl}/api/voice/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: history.slice(-30).map(m => ({ role: m.role, content: m.content })),
          current_state: getFormSnapshot(),
        }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        let detail = `${response.status}`
        try {
          const body = await response.json() as { detail?: unknown }
          if (typeof body.detail === 'string') detail = body.detail
        } catch { /* keep the status code */ }
        throw new Error(detail)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const piece = JSON.parse(data) as { content?: string; error?: string }
            if (piece.error !== undefined) throw new Error(piece.error)
            if (piece.content !== undefined) {
              acc += piece.content
              setStreamText(acc)
            }
          } catch (parseError) {
            if (parseError instanceof SyntaxError) continue
            throw parseError
          }
        }
      }
      if (seq === seqRef.current) {
        setMessages(current => [...current, { role: 'assistant', content: acc }])
        setStreamText('')
      }
    } catch (sendError) {
      if (sendError instanceof DOMException && sendError.name === 'AbortError') {
        // A manual stop keeps whatever streamed so far.
        if (acc !== '' && seq === seqRef.current) {
          const partial = acc
          setMessages(msgs => [...msgs, { role: 'assistant', content: partial }])
        }
        setStreamText('')
      } else {
        setError(sendError instanceof Error ? sendError.message : String(sendError))
      }
    } finally {
      if (seq === seqRef.current) {
        setStreaming(false)
        abortRef.current = null
      }
    }
  }, [getFormSnapshot, messages, serviceUrl, streaming])

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clearHistory = useCallback(() => {
    setMessages([])
    setAppliedMarks(new Set())
    setError(null)
    try { window.localStorage.removeItem(HISTORY_KEY) } catch { /* non-fatal */ }
  }, [])

  /** Parse + apply one voice-params block from message `index`. */
  const applyBlock = useCallback((index: number, code: string) => {
    try {
      const parsed = JSON.parse(code) as VoiceAssistantParams
      if (typeof parsed !== 'object' || parsed === null) return
      applyParams(parsed)
      setAppliedMarks(current => new Set(current).add(index))
      setError(null)
    } catch {
      setError(t('voice.assistant.parseFailed'))
    }
  }, [applyParams, t])

  const quickPrompts = useMemo(() => QUICK_PROMPT_KEYS.map(key => t(key)), [t])

  /** Render one assistant message: text + code fences + apply buttons. */
  const renderAssistant = (msg: AssistantMsg, index: number, isStreaming: boolean) => {
    const segments = splitSegments(msg.content)
    let blockSeq = 0
    return segments.map((segment, segmentIndex) => {
      if (segment.kind === 'text') {
        return segment.text.trim() === ''
          ? null
          : <div className={css.bubble} key={segmentIndex}>{segment.text.replace(/\n+$/u, '')}</div>
      }
      const isParams = segment.lang === 'voice-params'
      const blockIndex = index * 100 + blockSeq++
      let parsed: unknown = null
      if (isParams) {
        try { parsed = JSON.parse(segment.code) } catch { parsed = null }
      }
      return (
        <div className={css.applyRow} key={segmentIndex} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <pre className={css.codeBlock}>{segment.code}</pre>
          {isParams && !isStreaming && (
            appliedMarks.has(blockIndex)
              ? <span className={css.appliedMark}><IconCheckOutline14 size={14} />{t('voice.assistant.applied')}</span>
              : parsed !== null
                ? (
                  <button type="button" className={css.chip} onClick={() => applyBlock(blockIndex, segment.code)}>
                    ✨
                    {t('voice.assistant.apply')}
                  </button>
                )
                : null
          )}
        </div>
      )
    })
  }

  return (
    <div className={css.window} role="dialog" aria-label={t('voice.assistant.title')}>
      <div className={css.header}>
        <span className={css.headerIcon}><IconSparkle16 size={16} /></span>
        <div>
          <h3 className={css.headerTitle}>{t('voice.assistant.title')}</h3>
          <span className={css.headerSub}>IndexTTS-2.5 · qwen3.8-max</span>
        </div>
        <div className={css.headerActions}>
          <button type="button" className={css.iconBtn} title={t('voice.assistant.clear')} aria-label={t('voice.assistant.clear')} onClick={clearHistory}>
            <IconTrashOutline16 size={15} />
          </button>
          <button type="button" className={css.iconBtn} title={t('close')} aria-label={t('close')} onClick={onClose}>
            <IconCloseOutline16 size={15} />
          </button>
        </div>
      </div>

      <div className={css.messages} ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className={css.empty}>
            {t('voice.assistant.empty')}
            {!available && (
              <>
                <br />
                {t('voice.assistant.offline')}
              </>
            )}
          </div>
        )}
        {messages.map((msg, index) => (
          <div className={css.msg} data-role={msg.role} key={`${String(index)}-${msg.content.slice(0, 12)}`}>
            {msg.role === 'user'
              ? <div className={css.bubble}>{msg.content}</div>
              : renderAssistant(msg, index, false)}
          </div>
        ))}
        {streaming && (
          <div className={css.msg} data-role="assistant">
            {streamText === ''
              ? (
                <div className={css.bubble}>
                  <IconLoadingOutline16 size={14} className={css.spin} />
                  {' '}
                  {t('voice.assistant.thinking')}
                </div>
              )
              : renderAssistant({ role: 'assistant', content: streamText }, 999999, true)}
          </div>
        )}
      </div>

      {messages.length === 0 && !streaming && (
        <div className={css.chips}>
          {quickPrompts.map(prompt => (
            <button type="button" className={css.chip} key={prompt} disabled={!available} onClick={() => { void send(prompt) }}>
              {prompt}
            </button>
          ))}
        </div>
      )}
      {error !== null && <div className={css.errLine}>{error}</div>}

      <div className={css.inputRow}>
        <textarea
          className={css.input}
          rows={1}
          placeholder={t('voice.assistant.placeholder')}
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send(input)
            }
          }}
        />
        {streaming
          ? (
            <button type="button" className={css.sendBtn} aria-label={t('voice.assistant.stop')} onClick={stopStreaming}>
              <IconStopFill16 size={16} />
            </button>
          )
          : (
            <button type="button" className={css.sendBtn} disabled={!available || input.trim() === ''} aria-label={t('voice.assistant.send')} onClick={() => { void send(input) }}>
              <IconSendOutline16 size={16} />
            </button>
          )}
      </div>
    </div>
  )
}
