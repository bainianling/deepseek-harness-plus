/**
 * Dedicated 浮光 link card inside the voice-clone studio: binds the reference
 * voice and default parameters that the 浮光 desktop app reads before every
 * synthesis (GET /api/voice/profiles/fuguang). 浮光 itself fills the dynamic
 * parameters per message (the text, her live mood → emotion, language), so
 * this card only manages the durable "her voice" configuration, with an
 * audition button to hear the result.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconLoadingOutline16, IconPaperclipOutline16, IconPlayOutline16,
  IconRefreshOutline16, IconVoiceOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import {
  api, defaultFuguangProfile, VOICE_LANGS,
  type SynthResult, type UploadResponse, type VoiceFileEntry, type VoiceProfile, type VoiceStatus,
} from './voiceService.ts'
import css from './VoiceCloneApp.module.css'

interface VoiceFuguangCardProps {
  t: AppFrameProps['t']
  serviceUrl: string
  online: boolean
  modelLoaded: boolean
  status: VoiceStatus | null
}

export function VoiceFuguangCard({ t, serviceUrl, online, modelLoaded, status }: VoiceFuguangCardProps) {
  const [profile, setProfile] = useState<VoiceProfile>(defaultFuguangProfile)
  const [exists, setExists] = useState(false) // a saved copy lives on the server
  const [dirty, setDirty] = useState(false)
  const [files, setFiles] = useState<VoiceFileEntry[]>([])
  const [busyLoad, setBusyLoad] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [noteError, setNoteError] = useState(false)
  const [testResult, setTestResult] = useState<SynthResult | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  /** One draft edit; clears the last feedback line. */
  const patch = useCallback((partial: Partial<VoiceProfile>) => {
    setProfile(current => ({ ...current, ...partial }))
    setDirty(true)
    setNote(null)
  }, [])

  /** (Re)load the saved profile plus the uploaded-file list from the service. */
  const refresh = useCallback(async () => {
    if (!online) return
    setBusyLoad(true)
    try {
      const listed = await api<{ files: VoiceFileEntry[] }>(serviceUrl, '/api/voice/files')
      setFiles(listed.files)
      // Raw fetch so the 404 (no profile yet) is told apart from real errors.
      const response = await fetch(`${serviceUrl}/api/voice/profiles/fuguang`)
      if (response.ok) {
        const stored = await response.json() as Partial<VoiceProfile>
        setProfile({ ...defaultFuguangProfile(), ...stored })
        setExists(true)
        setDirty(false)
      } else if (response.status === 404) {
        setExists(false)
      }
    } catch { /* offline mid-flight: the status probe resets the card state */ }
    finally {
      setBusyLoad(false)
    }
  }, [online, serviceUrl])

  useEffect(() => { void refresh() }, [refresh])

  /** Upload one new reference voice and bind it to 浮光 right away. */
  const handleUpload = useCallback(async (file: File) => {
    setUploading(true)
    setNote(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const uploaded = await api<UploadResponse>(serviceUrl, '/api/voice/upload', { method: 'POST', body: form })
      setFiles(current => [
        ...current.filter(entry => entry.id !== uploaded.id),
        // The upload response carries the display name, not stored_as.
        { id: uploaded.id, stored_as: uploaded.name, seconds: uploaded.seconds },
      ])
      patch({ ref_id: uploaded.id })
    } catch (error) {
      setNote(error instanceof Error && error.message !== '__offline__' ? error.message : t('voice.generate.needOnline'))
      setNoteError(true)
    } finally {
      setUploading(false)
    }
  }, [patch, serviceUrl, t])

  /** Persist the draft as the fuguang profile; resolves false on failure. */
  const save = useCallback(async (): Promise<boolean> => {
    if (profile.ref_id === null) {
      setNote(t('voice.fuguang.needVoice'))
      setNoteError(true)
      return false
    }
    setSaving(true)
    try {
      await api(serviceUrl, '/api/voice/profiles/fuguang', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(profile),
      })
      setExists(true)
      setDirty(false)
      setNote(t('voice.fuguang.saved'))
      setNoteError(false)
      return true
    } catch (error) {
      setNote(error instanceof Error && error.message !== '__offline__' ? error.message : t('voice.generate.needOnline'))
      setNoteError(true)
      return false
    } finally {
      setSaving(false)
    }
  }, [profile, serviceUrl, t])

  /** Audition: save when dirty, then synthesize one sample sentence. */
  const audition = useCallback(async () => {
    setNote(null)
    setNoteError(false)
    setTestResult(null)
    if (!online) { setNote(t('voice.generate.needOnline')); setNoteError(true); return }
    if (!modelLoaded) { setNote(t('voice.generate.needModel')); setNoteError(true); return }
    if (profile.ref_id === null) { setNote(t('voice.fuguang.needVoice')); setNoteError(true); return }
    setTesting(true)
    try {
      if (dirty && !await save()) return
      setNote(t('voice.fuguang.testing'))
      const synth = await api<SynthResult>(serviceUrl, '/api/voice/profiles/fuguang/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      setTestResult(synth)
      setNote(`${t('voice.result.elapsed')} ${String(synth.elapsed_seconds)}s`)
    } catch (error) {
      setNote(error instanceof Error && error.message === '__offline__'
        ? t('voice.generate.needOnline')
        : error instanceof Error ? error.message : String(error))
      setNoteError(true)
    } finally {
      setTesting(false)
    }
  }, [dirty, modelLoaded, online, profile.ref_id, save, serviceUrl, t])

  const unbound = profile.ref_id === null
  const stateKind = !online ? 'offline' : unbound ? 'offline' : dirty || !exists ? 'checking' : 'online'
  const stateLabel = !online
    ? t('voice.status.offline')
    : unbound ? t('voice.fuguang.unbound') : dirty || !exists ? t('voice.fuguang.draft') : t('voice.fuguang.bound')

  return (
    <div className={`${css.card} ${css.fuguangCard}`}>
      <div className={css.cardHead}>
        <span className={css.fuguangIcon}><IconVoiceOutline16 size={14} /></span>
        <h3 className={css.cardTitle}>{t('voice.fuguang.card')}</h3>
        <span className={css.statusPill}>
          <span className={css.dot} data-kind={stateKind} />
          {stateLabel}
        </span>
        <div className={css.cardHeadActions}>
          <Button size="sm" disabled={!online || busyLoad} icon={<IconRefreshOutline16 size={16} />} onClick={() => { void refresh() }}>
            {t('retry')}
          </Button>
          <Button
            size="sm"
            variant={dirty || !exists ? 'primary' : 'outline'}
            disabled={!online || saving || unbound}
            icon={saving ? <IconLoadingOutline16 size={16} className={css.spin} /> : undefined}
            onClick={() => { void save() }}
          >
            {saving ? t('voice.fuguang.saving') : t('voice.fuguang.save')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!online || !modelLoaded || testing || saving || status?.busy === true}
            icon={testing ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconPlayOutline16 size={16} />}
            onClick={() => { void audition() }}
          >
            {testing ? t('voice.fuguang.testing') : t('voice.fuguang.test')}
          </Button>
        </div>
      </div>
      <p className={css.hint}>{t('voice.fuguang.hint')}</p>

      {/* Her voice: bind one uploaded reference or upload a fresh one. */}
      <div className={css.row}>
        <span className={css.sliderLabel}>{t('voice.fuguang.voice')}</span>
        <select
          className={css.select}
          value={profile.ref_id ?? ''}
          disabled={!online || files.length === 0}
          onChange={event => patch({ ref_id: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">{files.length === 0 ? t('voice.fuguang.voiceEmpty') : t('voice.fuguang.voicePick')}</option>
          {files.map(file => (
            <option key={file.id} value={file.id}>
              {file.stored_as}
              {file.seconds !== null ? ` · ${file.seconds.toFixed(1)}s` : ''}
            </option>
          ))}
        </select>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) void handleUpload(file)
            event.target.value = ''
          }}
        />
        <Button
          size="sm"
          disabled={!online || uploading}
          icon={uploading ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconPaperclipOutline16 size={16} />}
          onClick={() => { fileInput.current?.click() }}
        >
          {uploading ? t('voice.ref.uploading') : t('voice.fuguang.upload')}
        </Button>
      </div>
      {profile.ref_id !== null && (
        /* eslint-disable-next-line jsx-a11y/media-has-caption -- preview of the bound reference voice */
        <audio controls preload="none" src={`${serviceUrl}/api/voice/files/${profile.ref_id}/audio`} />
      )}

      {/* Durable defaults; 浮光 fills the rest per message on her own. */}
      <div className={css.segmentRow}>
        <span className={css.sliderLabel}>{t('voice.fuguang.lang')}</span>
        {VOICE_LANGS.map(code => (
          <button
            key={code}
            type="button"
            className={css.segment}
            data-active={profile.lang === code || undefined}
            onClick={() => patch({ lang: code })}
          >
            {t(`voice.lang.${code}`)}
          </button>
        ))}
      </div>
      <div className={css.sliderRow}>
        <span className={css.sliderLabel}>{t('voice.speed.card')}</span>
        <input
          type="range"
          className={css.slider}
          min={0.5}
          max={2}
          step={0.05}
          value={profile.duration_factor}
          onChange={event => patch({ duration_factor: Number(event.target.value) })}
        />
        <span className={css.sliderValue}>{profile.duration_factor.toFixed(2)}x</span>
      </div>
      <label className={css.checkboxRow}>
        <input type="checkbox" checked={profile.emo_follow} onChange={event => patch({ emo_follow: event.target.checked })} />
        {t('voice.fuguang.emoFollow')}
      </label>
      <label className={css.checkboxRow}>
        <input type="checkbox" checked={profile.use_random} onChange={event => patch({ use_random: event.target.checked })} />
        {t('voice.emo.random')}
      </label>

      {note !== null && <div className={css.generateNote} data-error={noteError || undefined}>{note}</div>}
      {testResult !== null && (
        <div className={css.resultAudio}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- synthesized audition for the bound profile */}
          <audio controls autoPlay src={serviceUrl + testResult.audio_url} />
        </div>
      )}
      {exists && !dirty && profile.updated_at !== undefined && (
        <p className={css.hint}>
          {t('voice.fuguang.updatedAt')}
          {' '}
          {new Date(profile.updated_at * 1000).toLocaleString()}
        </p>
      )}
    </div>
  )
}
