/**
 * Shared client for the local IndexTTS-2.5 voice service (DSH Voice Service,
 * default http://127.0.0.1:8917). Consumed by the studio (VoiceCloneApp) and
 * the dedicated 浮光 link card (VoiceFuguangCard); the 浮光 desktop app speaks
 * the same HTTP API from its own process.
 */

export const DEFAULT_PORT_URL = 'http://127.0.0.1:8917'

/** Languages IndexTTS-2.5 synthesizes (service-side LANGS mirror). */
export const VOICE_LANGS = ['ZH', 'EN', 'JA', 'ES', 'AR'] as const

/** Service + model + GPU state as reported by GET /api/voice/status. */
export interface VoiceStatus {
  service?: string
  busy?: boolean
  model_loaded?: boolean
  loading?: boolean
  load_error?: string | null
  use_qwen_emo?: boolean
  gpu?: string
  vram_total_gb?: number
  vram_used_gb?: number
  profiles?: string[]
  assistant?: { available?: boolean; model?: string }
}

export interface UploadedAudio {
  id: string
  name: string
  seconds: number | null
  url: string
}

/** Raw /api/voice/upload response before the url is absolutized. */
export interface UploadResponse {
  id: string
  name: string
  seconds: number | null
  preview_url: string
}

export interface SynthResult {
  audio_name: string
  audio_url: string
  seconds: number | null
  elapsed_seconds: number
}

/** One uploaded reference/emotion audio file as listed by /api/voice/files. */
export interface VoiceFileEntry {
  id: string
  stored_as: string
  seconds: number | null
}

/** Advanced sampling block (mirrors the service's AdvancedParams model plus
    the two stream controls the studio keeps beside it). */
export interface VoiceAdvancedParams {
  do_sample: boolean
  top_p: number
  top_k: number
  temperature: number
  length_penalty: number
  num_beams: number
  repetition_penalty: number
  max_mel_tokens: number
  max_text_tokens_per_segment: number
  interval_silence: number
  text_normalization: boolean
}

/** Named app voice profile (PUT /api/voice/profiles/{name}). */
export interface VoiceProfile {
  display_name: string
  ref_id: string | null
  emo_ref_id: string | null
  lang: string
  emo_mode: number
  emo_alpha: number
  emo_vector: number[] | null
  emo_text: string | null
  /** When true the client app fills emotion from its live mood per message. */
  emo_follow: boolean
  use_random: boolean
  duration_factor: number
  interval_silence: number
  text_normalization: boolean
  advanced: VoiceAdvancedParams
  updated_at?: number
}

export const DEFAULT_ADVANCED: VoiceAdvancedParams = {
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

/** Fresh 浮光 profile draft (nothing bound yet, gentle defaults). */
export function defaultFuguangProfile(): VoiceProfile {
  return {
    display_name: '浮光',
    ref_id: null,
    emo_ref_id: null,
    lang: 'ZH',
    emo_mode: 0,
    emo_alpha: 0.65,
    emo_vector: null,
    emo_text: null,
    emo_follow: true,
    use_random: false,
    duration_factor: 1.0,
    interval_silence: 200,
    text_normalization: true,
    advanced: { ...DEFAULT_ADVANCED },
  }
}

/** The service base URL, overridable through localStorage. */
export function readServiceUrl(): string {
  try {
    const stored = window.localStorage.getItem('dsh.voiceServiceUrl')
    if (stored !== null && stored.trim() !== '' && /^https?:\/\//u.test(stored)) return stored.trim().replace(/\/+$/u, '')
  } catch { /* storage unavailable */ }
  return DEFAULT_PORT_URL
}

/** One JSON call against the voice service; non-2xx throws with the detail. */
export async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
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
