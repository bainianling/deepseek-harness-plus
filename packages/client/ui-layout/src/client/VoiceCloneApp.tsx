/**
 * Voice clone studio: the functional occupant of the app-level nav rail's
 * "voice" section. Wraps the local IndexTTS-2.5 FastAPI service
 * (http://127.0.0.1:8917) and exposes every engine feature as a dedicated
 * control: reference audio (upload/record), four emotion modes plus random
 * emotion and intensity, language, speaking rate, pronunciation annotations,
 * advanced sampling parameters, model load/unload, synthesis and history.
 * Pure component like AppFrame: no cordis, everything local or fetched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconCloseOutline16, IconDownloadOutline16, IconLoadingOutline16, IconPaperclipOutline16,
  IconPlayOutline16, IconPlusOutline16, IconRefreshOutline16, IconSendOutline16,
  IconSparkle16, IconStopFill16, IconTrashOutline16, IconVoiceOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import { VoiceAssistantApp, type VoiceAssistantParams } from './VoiceAssistant.tsx'
import css from './VoiceCloneApp.module.css'

/** Emotion vector dimension order, matching IndexTTS-2.5 exactly. */
const EMOTION_KEYS = [
  'voice.emo.happy', 'voice.emo.angry', 'voice.emo.sad', 'voice.emo.afraid',
  'voice.emo.disgusted', 'voice.emo.melancholic', 'voice.emo.surprised', 'voice.emo.calm',
] as const

/** Languages IndexTTS-2.5 synthesizes. */
const LANGS = ['ZH', 'EN', 'JA', 'ES', 'AR'] as const
type Lang = typeof LANGS[number]

/** Emotion control mode ids shared with the service. */
type EmoMode = 0 | 1 | 2 | 3

interface VoiceStatus {
  service?: string
  busy?: boolean
  model_loaded?: boolean
  loading?: boolean
  load_error?: string | null
  use_qwen_emo?: boolean
  gpu?: string
  vram_total_gb?: number
  vram_used_gb?: number
  assistant?: { available?: boolean; model?: string }
}

interface UploadedAudio {
  id: string
  name: string
  seconds: number | null
  url: string
}

/** Raw /api/voice/upload response before the url is absolutized. */
interface UploadResponse {
  id: string
  name: string
  seconds: number | null
  preview_url: string
}

interface SynthResult {
  audio_name: string
  audio_url: string
  seconds: number | null
  elapsed_seconds: number
}

interface HistoryEntry {
  name: string
  url: string
  seconds: number | null
  at: number
  preview: string
}

/** Default advanced sampling parameters (the webui defaults). */
const DEFAULT_ADVANCED = {
  do_sample: true,
  top_p: 0.8,
  top_k: 30,
  temperature: 0.8,
  length_penalty: 0,
  num_beams: 3,
  repetition_penalty: 10,
  max_mel_tokens: 1500,
  max_text_tokens_per_segment: 120,
  interval_silence: 200,
  text_normalization: true,
}

const DEFAULT_PORT_URL = 'http://127.0.0.1:8917'
const START_COMMAND = 'F:\\deepseek-harness\\voice-clone\\start-voice-service.cmd'

/** The service base URL, overridable through localStorage. */
function readServiceUrl(): string {
  try {
    const stored = window.localStorage.getItem('dsh.voiceServiceUrl')
    if (stored !== null && stored.trim() !== '' && /^https?:\/\//u.test(stored)) return stored.trim().replace(/\/+$/u, '')
  } catch { /* storage unavailable */ }
  return DEFAULT_PORT_URL
}

/** One JSON call against the voice service; non-2xx throws with the detail. */
async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(base + path, init)
  } catch {
    throw new Error('__offline__')
  }
  if (!response.ok) {
    let detail = `${response.status}`
    try {
      const body = await response.json() as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch { /* keep the status code */ }
    throw new Error(detail)
  }
  return await response.json() as T
}

/** Voice section props: only the shared locale translator arrives. */
export function VoiceCloneApp({ t }: { t: AppFrameProps['t'] }) {
  const [serviceUrl, setServiceUrl] = useState(readServiceUrl)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [online, setOnline] = useState<boolean | null>(null) // null = checking
  const [loadError, setLoadError] = useState<string | null>(null)
  const [qwenEmo, setQwenEmo] = useState(false)

  const [refAudio, setRefAudio] = useState<UploadedAudio | null>(null)
  const [emoAudio, setEmoAudio] = useState<UploadedAudio | null>(null)
  const [uploading, setUploading] = useState<{ ref: boolean; emo: boolean }>({ ref: false, emo: false })
  const [recordingTarget, setRecordingTarget] = useState<'ref' | 'emo' | null>(null)
  const recorderRef = useRef<{ rec: MediaRecorder; chunks: Blob[] } | null>(null)

  const [text, setText] = useState('')
  const [lang, setLang] = useState<Lang>('ZH')
  const [emoMode, setEmoMode] = useState<EmoMode>(0)
  const [emoAlpha, setEmoAlpha] = useState(0.65)
  const [emoVector, setEmoVector] = useState<number[]>([0, 0, 0, 0, 0, 0, 0, 0])
  const [emoText, setEmoText] = useState('')
  const [useRandom, setUseRandom] = useState(false)
  const [durationFactor, setDurationFactor] = useState(1.0)
  const [advanced, setAdvanced] = useState({ ...DEFAULT_ADVANCED })
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [genNote, setGenNote] = useState<string | null>(null)
  const [genError, setGenError] = useState(false)
  const [result, setResult] = useState<SynthResult | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])

  const refFileInput = useRef<HTMLInputElement | null>(null)
  const emoFileInput = useRef<HTMLInputElement | null>(null)

  /** Floating AI assistant window state (persisted open/closed). */
  const [assistantOpen, setAssistantOpen] = useState(() => {
    try { return window.localStorage.getItem('dsh.voiceAssistant.open') === '1' } catch { return false }
  })
  const toggleAssistant = useCallback(() => {
    setAssistantOpen((current) => {
      const next = !current
      try { window.localStorage.setItem('dsh.voiceAssistant.open', next ? '1' : '0') } catch { /* non-fatal */ }
      return next
    })
  }, [])
  const closeAssistant = useCallback(() => {
    setAssistantOpen(false)
    try { window.localStorage.setItem('dsh.voiceAssistant.open', '0') } catch { /* non-fatal */ }
  }, [])

  const onlineFlag = online === true
  const loading = status?.loading === true
  const modelLoaded = status?.model_loaded === true
  const busy = status?.busy === true || generating

  /** One status probe; a failed fetch marks the service offline. */
  const probe = useCallback(async () => {
    try {
      const next = await api<VoiceStatus>(serviceUrl, '/api/voice/status')
      setStatus(next)
      setOnline(true)
      setLoadError(next.load_error ?? null)
    } catch (error) {
      if (error instanceof Error && error.message === '__offline__') {
        setOnline(false)
        setStatus(null)
      } else {
        // The service answered with an error JSON — still online.
        setOnline(true)
      }
    }
  }, [serviceUrl])

  useEffect(() => {
    void probe()
    const slow = window.setInterval(() => { void probe() }, 5000)
    return () => { window.clearInterval(slow) }
  }, [probe])

  // Fast polling while the model loads or a synthesis runs, so the buttons
  // track the backend without the user pressing retry.
  useEffect(() => {
    if (!onlineFlag || (!loading && !busy)) return
    const fast = window.setInterval(() => { void probe() }, 1500)
    return () => { window.clearInterval(fast) }
  }, [onlineFlag, loading, busy, probe])

  /** Upload one file into the service store and return the descriptor. */
  const uploadFile = useCallback(async (file: File): Promise<UploadedAudio> => {
    const form = new FormData()
    form.append('file', file)
    const uploaded = await api<UploadResponse>(serviceUrl, '/api/voice/upload', { method: 'POST', body: form })
    return { id: uploaded.id, name: uploaded.name, seconds: uploaded.seconds, url: serviceUrl + uploaded.preview_url }
  }, [serviceUrl])

  const handleUpload = useCallback(async (target: 'ref' | 'emo', file: File) => {
    setUploading(current => ({ ...current, [target]: true }))
    try {
      const uploaded = await uploadFile(file)
      if (target === 'ref') setRefAudio(uploaded)
      else setEmoAudio(uploaded)
    } catch (error) {
      setGenNote(error instanceof Error && error.message === '__offline__'
        ? t('voice.generate.needOnline')
        : error instanceof Error ? error.message : String(error))
      setGenError(true)
    } finally {
      setUploading(current => ({ ...current, [target]: false }))
    }
  }, [t, uploadFile])

  /** MediaRecorder capture; the stop handler converts and uploads. */
  const startRecording = useCallback(async (target: 'ref' | 'emo') => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      rec.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      rec.onstop = () => {
        stream.getTracks().forEach(track => { track.stop() })
        const type = rec.mimeType !== '' ? rec.mimeType : 'audio/webm'
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
        const file = new File([new Blob(chunks, { type })], `recording-${new Date().toISOString().replaceAll(':', '-')}.${ext}`, { type })
        void handleUpload(target, file)
      }
      rec.start()
      recorderRef.current = { rec, chunks }
      setRecordingTarget(target)
    } catch {
      setGenNote(t('voice.ref.micError'))
      setGenError(true)
    }
  }, [handleUpload, t])

  const stopRecording = useCallback(() => {
    recorderRef.current?.rec.stop()
    recorderRef.current = null
    setRecordingTarget(null)
  }, [])

  const loadModel = useCallback(async () => {
    setLoadError(null)
    try {
      await api(serviceUrl, '/api/voice/load', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ use_bf16: true, use_qwen_emo: qwenEmo }),
      })
      void probe()
    } catch (error) {
      setLoadError(error instanceof Error && error.message !== '__offline__' ? error.message : t('voice.generate.needOnline'))
    }
  }, [probe, qwenEmo, serviceUrl, t])

  const unloadModel = useCallback(async () => {
    try {
      await api(serviceUrl, '/api/voice/unload', { method: 'POST' })
      void probe()
    } catch { /* status polling recovers the truth */ }
  }, [probe, serviceUrl])

  const copyStartCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(START_COMMAND)
    } catch { /* clipboard may need focus; the visible command stays selectable */ }
  }, [])

  /** One synthesis pass: collect every control into the service payload. */
  const synthesize = useCallback(async () => {
    setGenError(false)
    if (!onlineFlag) { setGenNote(t('voice.generate.needOnline')); setGenError(true); return }
    if (!modelLoaded) { setGenNote(t('voice.generate.needModel')); setGenError(true); return }
    if (refAudio === null) { setGenNote(t('voice.generate.needRef')); setGenError(true); return }
    if (text.trim() === '') { setGenNote(t('voice.generate.needText')); setGenError(true); return }
    setGenerating(true)
    setGenNote(t('voice.generating'))
    try {
      const body = {
        text,
        lang,
        ref_id: refAudio.id,
        emo_mode: emoMode,
        emo_ref_id: emoMode === 1 ? emoAudio?.id ?? null : null,
        emo_alpha: emoAlpha,
        emo_vector: emoMode === 2 ? emoVector : null,
        emo_text: emoMode === 3 ? emoText : null,
        use_random: useRandom,
        duration_factor: durationFactor,
        interval_silence: advanced.interval_silence,
        text_normalization: advanced.text_normalization,
        advanced: {
          do_sample: advanced.do_sample,
          top_p: advanced.top_p,
          top_k: advanced.top_k,
          temperature: advanced.temperature,
          length_penalty: advanced.length_penalty,
          num_beams: advanced.num_beams,
          repetition_penalty: advanced.repetition_penalty,
          max_mel_tokens: advanced.max_mel_tokens,
          max_text_tokens_per_segment: advanced.max_text_tokens_per_segment,
        },
      }
      const synth = await api<SynthResult>(serviceUrl, '/api/voice/synthesize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      setResult(synth)
      setGenNote(`${t('voice.result.elapsed')} ${String(synth.elapsed_seconds)}s`)
      setHistory(current => [{
        name: synth.audio_name,
        url: serviceUrl + synth.audio_url,
        seconds: synth.seconds,
        at: Date.now(),
        preview: text.slice(0, 40),
      }, ...current].slice(0, 30))
    } catch (error) {
      setGenNote(error instanceof Error && error.message === '__offline__'
        ? t('voice.generate.needOnline')
        : error instanceof Error ? error.message : String(error))
      setGenError(true)
    } finally {
      setGenerating(false)
    }
  }, [advanced, durationFactor, emoAlpha, emoAudio, emoMode, emoText, emoVector, lang, modelLoaded, onlineFlag, refAudio, serviceUrl, t, text, useRandom])

  const insertAnnotationExample = useCallback(() => {
    setText(current => `${current}${current !== '' ? ' ' : ''}<行|xíng>动 <bank|B AE1 NG K>`)
  }, [])

  /** Apply one AI-suggested voice-params block to the studio form. */
  const applyAssistantParams = useCallback((params: VoiceAssistantParams) => {
    if (typeof params.lang === 'string' && (LANGS as readonly string[]).includes(params.lang)) setLang(params.lang as Lang)
    if (typeof params.duration_factor === 'number' && params.duration_factor >= 0.5 && params.duration_factor <= 2) setDurationFactor(params.duration_factor)
    if (typeof params.emo_mode === 'number' && params.emo_mode >= 0 && params.emo_mode <= 3) setEmoMode(Math.round(params.emo_mode) as EmoMode)
    if (typeof params.emo_alpha === 'number' && params.emo_alpha >= 0 && params.emo_alpha <= 1) setEmoAlpha(params.emo_alpha)
    if (Array.isArray(params.emo_vector) && params.emo_vector.length === 8 && params.emo_vector.every(v => typeof v === 'number')) {
      setEmoVector(params.emo_vector.map(v => Math.max(0, Math.min(1, v as number))))
    }
    if (typeof params.emo_text === 'string') setEmoText(params.emo_text)
    if (typeof params.use_random === 'boolean') setUseRandom(params.use_random)
    if (typeof params.text === 'string' && params.text.trim() !== '') setText(params.text)
    const adv = params.advanced ?? {}
    setAdvanced(current => ({
      ...current,
      ...(typeof params.interval_silence === 'number' ? { interval_silence: Math.max(0, Math.round(params.interval_silence)) } : {}),
      ...(typeof params.text_normalization === 'boolean' ? { text_normalization: params.text_normalization } : {}),
      ...(typeof adv.do_sample === 'boolean' ? { do_sample: adv.do_sample } : {}),
      ...(typeof adv.top_p === 'number' ? { top_p: adv.top_p } : {}),
      ...(typeof adv.top_k === 'number' ? { top_k: Math.round(adv.top_k) } : {}),
      ...(typeof adv.temperature === 'number' ? { temperature: adv.temperature } : {}),
      ...(typeof adv.length_penalty === 'number' ? { length_penalty: adv.length_penalty } : {}),
      ...(typeof adv.num_beams === 'number' ? { num_beams: Math.round(adv.num_beams) } : {}),
      ...(typeof adv.repetition_penalty === 'number' ? { repetition_penalty: adv.repetition_penalty } : {}),
      ...(typeof adv.max_mel_tokens === 'number' ? { max_mel_tokens: Math.round(adv.max_mel_tokens) } : {}),
      ...(typeof adv.max_text_tokens_per_segment === 'number' ? { max_text_tokens_per_segment: Math.round(adv.max_text_tokens_per_segment) } : {}),
    }))
  }, [])

  /** Live form snapshot injected into the assistant's context each turn. */
  const getFormSnapshot = useCallback((): Record<string, unknown> => ({
    lang,
    emo_mode: emoMode,
    emo_alpha: emoAlpha,
    emo_vector: emoVector,
    emo_text: emoText,
    use_random: useRandom,
    duration_factor: durationFactor,
    text: text.slice(0, 300),
    has_reference_audio: refAudio !== null,
    reference_seconds: refAudio?.seconds ?? null,
    has_emotion_audio: emoAudio !== null,
    advanced,
  }), [advanced, durationFactor, emoAlpha, emoAudio, emoMode, emoText, emoVector, lang, refAudio, text, useRandom])

  const formatSeconds = (seconds: number | null): string => seconds === null ? '' : `${seconds.toFixed(1)}s`

  const statusKind = online === null ? 'checking' : !onlineFlag ? 'offline' : busy ? 'busy' : 'online'
  const statusLabel = online === null
    ? t('voice.status.checking')
    : !onlineFlag ? t('voice.status.offline') : t('voice.status.online')

  const generateDisabled = !onlineFlag || !modelLoaded || busy
  const generateBlockReason = useMemo(() => {
    if (!onlineFlag) return t('voice.generate.needOnline')
    if (!modelLoaded) return loading ? t('voice.model.loading') : t('voice.generate.needModel')
    return null
  }, [loading, modelLoaded, onlineFlag, t])

  /** One reference/emotion audio picker row (upload + record + preview). */
  const renderAudioPicker = (target: 'ref' | 'emo') => {
    const value = target === 'ref' ? refAudio : emoAudio
    const isUploading = uploading[target]
    const isRecording = recordingTarget === target
    const fileInput = target === 'ref' ? refFileInput : emoFileInput
    return (
      <div className={css.audioBox}>
        <div className={css.row}>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file !== undefined) void handleUpload(target, file)
              event.target.value = ''
            }}
          />
          <Button
            size="sm"
            icon={<IconPaperclipOutline16 size={16} />}
            disabled={!onlineFlag || isUploading || isRecording}
            onClick={() => { fileInput.current?.click() }}
          >
            {t('voice.ref.upload')}
          </Button>
          {!isRecording
            ? (
              <Button
                size="sm"
                icon={<IconPlusOutline16 size={16} />}
                disabled={!onlineFlag || isUploading || recordingTarget !== null}
                onClick={() => { void startRecording(target) }}
              >
                {t('voice.ref.record')}
              </Button>
            )
            : (
              <Button size="sm" variant="outline" icon={<IconStopFill16 size={16} />} onClick={stopRecording}>
                {t('voice.ref.stopRecord')}
              </Button>
            )}
          {value !== null && (
            <Button
              size="sm"
              icon={<IconTrashOutline16 size={16} />}
              onClick={() => {
                if (target === 'ref') setRefAudio(null)
                else setEmoAudio(null)
              }}
            >
              {t('voice.ref.remove')}
            </Button>
          )}
          {isUploading && <span className={css.fileName}>{t('voice.ref.uploading')}</span>}
        </div>
        {value === null
          ? <div className={css.emptyBox}>{target === 'ref' ? t('voice.ref.empty') : t('voice.emo.audioNeedUpload')}</div>
          : (
            <>
              <span className={css.fileName}>
                {value.name}
                {value.seconds !== null ? ` · ${formatSeconds(value.seconds)}` : ''}
              </span>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption -- preview player for uploaded samples */}
              <audio controls preload="none" src={value.url} />
            </>
          )}
      </div>
    )
  }

  return (
    <div className={css.pane} role="region" aria-label={t('nav.voiceClone')}>
      <div className={css.column}>
        {/* Header: identity + live service state + recovery actions */}
        <div className={css.header}>
          <span className={css.headerIcon}><IconVoiceOutline16 size={22} /></span>
          <div className={css.headerText}>
            <h2 className={css.title}>{t('voice.title')}</h2>
            <p className={css.subtitle}>{t('voice.subtitle')}</p>
          </div>
          <div className={css.headerActions}>
            <span className={css.statusPill}>
              <span className={css.dot} data-kind={statusKind} />
              {statusLabel}
              {status?.gpu !== undefined ? ` · ${status.gpu}` : ''}
            </span>
            <Button
              size="sm"
              variant={assistantOpen ? 'primary' : 'outline'}
              icon={<IconSparkle16 size={16} />}
              onClick={toggleAssistant}
            >
              {t('voice.assistant.open')}
            </Button>
            <Button size="sm" icon={<IconRefreshOutline16 size={16} />} onClick={() => { void probe() }}>
              {t('retry')}
            </Button>
            {!onlineFlag && online !== null && (
              <Button size="sm" variant="primary" icon={<IconDownloadOutline16 size={16} />} onClick={() => { void copyStartCommand() }}>
                {t('voice.copyStartCmd')}
              </Button>
            )}
          </div>
        </div>
        {!onlineFlag && online !== null && (
          <div className={css.card}>
            <p className={css.hint}>{t('voice.startHint')}</p>
            <div className={css.mono}>{START_COMMAND}</div>
          </div>
        )}

        {/* Model & VRAM: load/unload + emotion-text guidance option */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('voice.model.card')}</h3>
            <div className={css.cardHeadActions}>
              {status?.vram_used_gb !== undefined && status.vram_total_gb !== undefined && (
                <span className={css.statusPill}>
                  {t('voice.model.vram')}
                  {` ${status.vram_used_gb.toFixed(1)} / ${status.vram_total_gb.toFixed(1)} GB`}
                </span>
              )}
              {!modelLoaded && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!onlineFlag || loading}
                  icon={loading ? <IconLoadingOutline16 size={16} className={css.spin} /> : undefined}
                  onClick={() => { void loadModel() }}
                >
                  {loading ? t('voice.model.loading') : t('voice.model.load')}
                </Button>
              )}
              {modelLoaded && (
                <Button size="sm" variant="outline" onClick={() => { void unloadModel() }}>
                  {t('voice.model.unload')}
                </Button>
              )}
            </div>
          </div>
          <label className={css.checkboxRow}>
            <input
              type="checkbox"
              checked={qwenEmo}
              disabled={modelLoaded || loading}
              onChange={event => setQwenEmo(event.target.checked)}
            />
            {t('voice.model.qwenEmo')}
          </label>
          {modelLoaded && <p className={css.hint}>{t('voice.model.loaded')}</p>}
          {loadError !== null && <p className={`${css.hint}`} style={{ color: '#e5484d' }}>{t('voice.model.loadError')}: {loadError}</p>}
        </div>

        {/* Voice reference audio */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('voice.ref.card')}</h3>
          </div>
          {renderAudioPicker('ref')}
        </div>

        {/* Emotion control: four modes + random + per-mode controls */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('voice.emo.card')}</h3>
            <div className={css.cardHeadActions}>
              <button
                type="button"
                className={css.segment}
                data-active={useRandom || undefined}
                aria-pressed={useRandom}
                onClick={() => setUseRandom(current => !current)}
                title={t('voice.emo.random')}
              >
                {useRandom ? t('voice.emo.randomOn') : t('voice.emo.random')}
              </button>
            </div>
          </div>
          <div className={css.segmentRow}>
            {([
              [0, 'voice.emo.mode.speaker'],
              [1, 'voice.emo.mode.audio'],
              [2, 'voice.emo.mode.vector'],
              [3, 'voice.emo.mode.text'],
            ] as const).map(([mode, key]) => (
              <button
                key={mode}
                type="button"
                className={css.segment}
                data-active={emoMode === mode || undefined}
                onClick={() => setEmoMode(mode)}
              >
                {t(key)}
              </button>
            ))}
          </div>
          {emoMode === 1 && (
            <>
              {renderAudioPicker('emo')}
              <div className={css.sliderRow}>
                <span className={css.sliderLabel}>{t('voice.emo.alpha')}</span>
                <input
                  type="range"
                  className={css.slider}
                  min={0}
                  max={1}
                  step={0.05}
                  value={emoAlpha}
                  onChange={event => setEmoAlpha(Number(event.target.value))}
                />
                <span className={css.sliderValue}>{emoAlpha.toFixed(2)}</span>
              </div>
            </>
          )}
          {emoMode === 2 && (
            <>
              <div className={css.vectorGrid}>
                {EMOTION_KEYS.map((key, index) => (
                  <div className={css.sliderRow} key={key}>
                    <span className={css.sliderLabel}>{t(key)}</span>
                    <input
                      type="range"
                      className={css.slider}
                      min={0}
                      max={1}
                      step={0.05}
                      value={emoVector[index] ?? 0}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setEmoVector(current => current.map((v, i) => (i === index ? value : v)))
                      }}
                    />
                    <span className={css.sliderValue}>{(emoVector[index] ?? 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className={css.row}>
                <Button size="sm" onClick={() => setEmoVector([0, 0, 0, 0, 0, 0, 0, 0])}>
                  {t('voice.emo.vectorReset')}
                </Button>
              </div>
            </>
          )}
          {emoMode === 3 && (
            <>
              <textarea
                className={css.textarea}
                data-short=""
                placeholder={t('voice.emo.textPlaceholder')}
                value={emoText}
                onChange={event => setEmoText(event.target.value)}
              />
              {!status?.use_qwen_emo && <p className={css.hint}>{t('voice.emo.textNeedModel')}</p>}
            </>
          )}
        </div>

        {/* Language + speaking rate */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('voice.lang.card')}</h3>
          </div>
          <div className={css.segmentRow}>
            {LANGS.map(code => (
              <button
                key={code}
                type="button"
                className={css.segment}
                data-active={lang === code || undefined}
                onClick={() => setLang(code)}
              >
                {t(`voice.lang.${code}`)}
              </button>
            ))}
          </div>
          <div className={css.sliderRow}>
            <span className={css.sliderLabel}>{t('voice.speed.card')}</span>
            <span className={css.sliderValue}>{t('voice.speed.fast')}</span>
            <input
              type="range"
              className={css.slider}
              min={0.5}
              max={2}
              step={0.05}
              value={durationFactor}
              onChange={event => setDurationFactor(Number(event.target.value))}
            />
            <span className={css.sliderValue}>{t('voice.speed.slow')}</span>
            <span className={css.sliderValue}>{durationFactor.toFixed(2)}x</span>
          </div>
          <div className={css.row}>
            {[0.75, 1, 1.25].map(value => (
              <Button key={value} size="sm" data-active={durationFactor === value || undefined} onClick={() => setDurationFactor(value)}>
                {value === 1 ? t('voice.speed.normal') : `${String(value)}x`}
              </Button>
            ))}
          </div>
        </div>

        {/* Text + pronunciation annotation helper */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('voice.text.card')}</h3>
            <div className={css.cardHeadActions}>
              <Button size="sm" icon={<IconPlusOutline16 size={16} />} onClick={insertAnnotationExample}>
                {t('voice.text.insertExample')}
              </Button>
            </div>
          </div>
          <textarea
            className={css.textarea}
            placeholder={t('voice.text.placeholder')}
            value={text}
            onChange={event => setText(event.target.value)}
          />
          <p className={css.hint}>{t('voice.text.annotationHint')}</p>
        </div>

        {/* Advanced sampling parameters */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <button type="button" className={css.cardTitle} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }} onClick={() => setShowAdvanced(current => !current)}>
              {showAdvanced ? '▾' : '▸'}
              {' '}
              {t('voice.advanced.card')}
            </button>
            <div className={css.cardHeadActions}>
              <Button size="sm" onClick={() => setAdvanced({ ...DEFAULT_ADVANCED })}>{t('voice.advanced.reset')}</Button>
            </div>
          </div>
          {showAdvanced && (
            <>
              <label className={css.checkboxRow}>
                <input type="checkbox" checked={advanced.do_sample} onChange={event => setAdvanced(current => ({ ...current, do_sample: event.target.checked }))} />
                {t('voice.advanced.doSample')}
              </label>
              <label className={css.checkboxRow}>
                <input type="checkbox" checked={advanced.text_normalization} onChange={event => setAdvanced(current => ({ ...current, text_normalization: event.target.checked }))} />
                {t('voice.advanced.textNormalization')}
              </label>
              {([
                ['top_p', t('voice.advanced.topP'), 0.05, 0, 1],
                ['temperature', t('voice.advanced.temperature'), 0.05, 0, 2],
                ['length_penalty', t('voice.advanced.lengthPenalty'), 0.1, -2, 2],
                ['repetition_penalty', t('voice.advanced.repetitionPenalty'), 0.5, 1, 20],
              ] as const).map(([field, label, step, min, max]) => (
                <div className={css.sliderRow} key={field}>
                  <span className={css.sliderLabel}>{label}</span>
                  <input
                    type="range"
                    className={css.slider}
                    min={min}
                    max={max}
                    step={step}
                    value={advanced[field]}
                    onChange={event => setAdvanced(current => ({ ...current, [field]: Number(event.target.value) }))}
                  />
                  <span className={css.sliderValue}>{advanced[field].toFixed(2)}</span>
                </div>
              ))}
              {([
                ['top_k', t('voice.advanced.topK')],
                ['num_beams', t('voice.advanced.numBeams')],
                ['max_mel_tokens', t('voice.advanced.maxMelTokens')],
                ['max_text_tokens_per_segment', t('voice.advanced.maxTextTokens')],
                ['interval_silence', t('voice.advanced.intervalSilence')],
              ] as const).map(([field, label]) => (
                <div className={css.sliderRow} key={field}>
                  <span className={css.sliderLabel}>{label}</span>
                  <input
                    type="number"
                    className={css.numberInput}
                    value={advanced[field]}
                    min={field === 'interval_silence' ? 0 : 1}
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      if (!Number.isNaN(value)) setAdvanced(current => ({ ...current, [field]: value }))
                    }}
                  />
                </div>
              ))}
              <div className={css.sliderRow}>
                <span className={css.sliderLabel}>{t('voice.advanced.serviceUrl')}</span>
                <input
                  type="text"
                  className={css.urlInput}
                  value={serviceUrl}
                  onChange={event => setServiceUrl(event.target.value.replace(/\/+$/u, ''))}
                  onBlur={() => {
                    try { window.localStorage.setItem('dsh.voiceServiceUrl', serviceUrl) } catch { /* non-fatal */ }
                    void probe()
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* Generate */}
        <div className={css.card}>
          <div className={css.generateRow}>
            <Button
              variant="primary"
              disabled={generateDisabled}
              icon={generating ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconSendOutline16 size={16} />}
              onClick={() => { void synthesize() }}
            >
              {generating ? t('voice.generating') : t('voice.generate')}
            </Button>
            {generateBlockReason !== null && <span className={css.generateNote}>{generateBlockReason}</span>}
            {genNote !== null && generateBlockReason === null && (
              <span className={css.generateNote} data-error={genError || undefined}>{genNote}</span>
            )}
          </div>
        </div>

        {/* Result */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('voice.result.card')}</h3>
            {result !== null && (
              <div className={css.cardHeadActions}>
                <a href={serviceUrl + result.audio_url} download={result.audio_name}>
                  <Button size="sm" icon={<IconDownloadOutline16 size={16} />}>{t('voice.result.download')}</Button>
                </a>
                <Button size="sm" icon={<IconCloseOutline16 size={16} />} onClick={() => setResult(null)}>
                  {t('voice.result.delete')}
                </Button>
              </div>
            )}
          </div>
          {result === null
            ? <div className={css.emptyBox}>{t('voice.result.empty')}</div>
            : (
              <div className={css.resultAudio}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- synthesized preview audio */}
                <audio controls autoPlay src={serviceUrl + result.audio_url} />
              </div>
            )}
        </div>

        {/* Session history */}
        <div className={css.card}>
          <div className={css.cardHead}>
            <h3 className={css.cardTitle}>{t('voice.history.card')}</h3>
            {history.length > 0 && (
              <div className={css.cardHeadActions}>
                <Button size="sm" icon={<IconTrashOutline16 size={16} />} onClick={() => setHistory([])}>
                  {t('voice.result.delete')}
                </Button>
              </div>
            )}
          </div>
          {history.length === 0
            ? <div className={css.emptyBox}>{t('voice.history.empty')}</div>
            : (
              <div className={css.historyList}>
                {history.map(entry => (
                  <div className={css.historyItem} key={entry.name} data-current={result?.audio_name === entry.name || undefined}>
                    <Button size="sm" icon={<IconPlayOutline16 size={16} />} aria-label={entry.name} onClick={() => setResult({ audio_name: entry.name, audio_url: entry.url.replace(serviceUrl, ''), seconds: entry.seconds, elapsed_seconds: 0 })} />
                    <span className={css.historyMeta}>
                      {entry.preview}
                      {' · '}
                      {new Date(entry.at).toLocaleTimeString()}
                      {entry.seconds !== null ? ` · ${formatSeconds(entry.seconds)}` : ''}
                    </span>
                    <a href={entry.url} download={entry.name}>
                      <Button size="sm" icon={<IconDownloadOutline16 size={16} />} aria-label={t('voice.result.download')} />
                    </a>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
      {/* Floating AI assistant: chat-only window dedicated to this studio. */}
      {assistantOpen && (
        <VoiceAssistantApp
          t={t}
          serviceUrl={serviceUrl}
          available={onlineFlag && status?.assistant?.available === true}
          onClose={closeAssistant}
          getFormSnapshot={getFormSnapshot}
          applyParams={applyAssistantParams}
        />
      )}
    </div>
  )
}
