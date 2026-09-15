/**
 * LoRA training studio: the functional occupant of the app-level nav rail's
 * "lora" section. Wraps the local DSH LoRA Training Service
 * (http://127.0.0.1:8918, kohya sd-scripts) and exposes every engine feature
 * as a dedicated control across four workbench tabs:
 *
 *   底模    — base model management (scan ComfyUI + managed models, import by
 *             local path or file upload, family auto-detection, delete, select)
 *   素材    — training datasets (create/delete, import from a local folder or
 *             upload, thumbnail grid, per-image caption editing, WD14
 *             auto-tagging, remove)
 *   训练    — full training config (network dim/alpha, LR, scheduler, epochs,
 *             repeats, resolution, VRAM-saving toggles, presets for SDXL 8G /
 *             SD1.5) plus start/stop and live monitoring (step/loss/ETA/speed,
 *             loss chart, log tail, sample preview images)
 *   模型库  — trained LoRAs (list, copy to ComfyUI, delete), test generation
 *             with base+LoRA, and merging a LoRA INTO a base model so the
 *             trained weights are embedded in a merged checkpoint.
 *
 * Pure component like AppFrame: no cordis, everything local or fetched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconArchiveOutline20, IconCheckOutline16, IconChipOutline16,
  IconDownloadOutline16, IconEditOutline16, IconFileOutline16, IconFolderOpenOutline16,
  IconLoadingOutline16, IconPaperclipOutline16, IconPlayOutline16,
  IconPlusOutline16, IconRefreshOutline16, IconSendOutline16, IconSettingsOutline16,
  IconStopFill16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './LoraTrainApp.module.css'

/** The four workbench tabs inside the lora section. */
type LoraTab = 'base' | 'dataset' | 'train' | 'output'

/** GPU info from the service status endpoint. */
interface GpuInfo {
  name?: string
  vram_total_gb?: number
  vram_used_gb?: number
}

interface ServiceStatus {
  service?: string
  gpu?: GpuInfo
  busy?: boolean
  training_running?: boolean
}

/** A base-model checkpoint entry. */
interface BaseModel {
  name: string
  path: string
  size_gb: number
  family: 'sdxl' | 'sd15' | 'unknown'
  managed: boolean
}

/** A dataset folder. */
interface DatasetInfo {
  name: string
  images: number
  captioned: number
}

/** One image inside a dataset. */
interface DatasetImage {
  file: string
  caption: string
  width: number
  height: number
  size_kb: number
}

/** Trained LoRA output entry. */
interface OutputModel {
  name: string
  size_mb: number
  mtime: number
}

/** Live training monitor payload. */
interface TrainStatus {
  running: boolean
  current_step: number
  total_steps: number
  loss: number | null
  loss_history: Array<{ step: number; loss: number }>
  speed: string
  eta: string
  elapsed: string
  error: string
  samples: string[]
  log_tail: string[]
}

/** Job status for async operations (tag / merge / testgen). */
interface JobStatus {
  id: string
  kind: string
  state: 'queued' | 'running' | 'done' | 'error'
  message: string
  error: string
  result: unknown
}

/** The persisted training configuration. */
interface TrainConfig {
  family: 'sdxl' | 'sd15'
  base_model: string
  dataset: string
  output_name: string
  network_dim: number
  network_alpha: number
  learning_rate: number
  lr_scheduler: string
  lr_warmup_steps: number
  max_train_epochs: number
  num_repeats: number
  resolution: number
  train_batch_size: number
  gradient_accumulation_steps: number
  max_token_length: number
  optimizer_type: string
  mixed_precision: string
  save_precision: string
  save_every_n_epochs: number
  seed: number
  min_snr_gamma: number
  noise_offset: number
  clip_skip: number
  cache_latents: boolean
  cache_latents_to_disk: boolean
  cache_text_encoder_outputs: boolean
  gradient_checkpointing: boolean
  mem_eff_attn: boolean
  unet_only: boolean
  enable_bucket: boolean
  shuffle_caption: boolean
  sample_every_n_epochs: number
  sample_prompts: string
}

const DEFAULT_PORT_URL = 'http://127.0.0.1:8918'
const START_COMMAND = 'lora_train\\start-lora-service.cmd'
const CFG_STORAGE_KEY = 'dsh.loraTrainCfg'

const LR_SCHEDULERS = [
  'constant', 'cosine', 'cosine_with_restarts', 'linear', 'polynomial', 'constant_with_warmup',
] as const
const OPTIMIZERS = ['AdamW8bit', 'AdamW', 'Prodigy', 'DAdaptation', 'Lion', 'SGDNesterov'] as const
const MIXED_PRECISIONS = ['fp16', 'bf16', 'no'] as const

/** SDXL preset tuned for the 8G laptop GPU (from the verified goutou run). */
const PRESET_SDXL_8G: TrainConfig = {
  family: 'sdxl', base_model: '', dataset: '', output_name: '',
  network_dim: 32, network_alpha: 16, learning_rate: 1e-4,
  lr_scheduler: 'cosine_with_restarts', lr_warmup_steps: 200,
  max_train_epochs: 8, num_repeats: 7, resolution: 768, train_batch_size: 1,
  gradient_accumulation_steps: 1, max_token_length: 225, optimizer_type: 'AdamW8bit',
  mixed_precision: 'fp16', save_precision: 'fp16', save_every_n_epochs: 1, seed: 42,
  min_snr_gamma: 5, noise_offset: 0, clip_skip: 1,
  cache_latents: true, cache_latents_to_disk: true, cache_text_encoder_outputs: true,
  gradient_checkpointing: true, mem_eff_attn: true, unet_only: true,
  enable_bucket: true, shuffle_caption: false, sample_every_n_epochs: 1,
  sample_prompts: '',
}

/** SD1.5 default preset (single-file checkpoints on the same engine). */
const PRESET_SD15: TrainConfig = {
  family: 'sd15', base_model: '', dataset: '', output_name: '',
  network_dim: 32, network_alpha: 16, learning_rate: 1e-4,
  lr_scheduler: 'cosine', lr_warmup_steps: 100,
  max_train_epochs: 10, num_repeats: 10, resolution: 512, train_batch_size: 1,
  gradient_accumulation_steps: 1, max_token_length: 75, optimizer_type: 'AdamW8bit',
  mixed_precision: 'fp16', save_precision: 'fp16', save_every_n_epochs: 1, seed: 42,
  min_snr_gamma: 5, noise_offset: 0, clip_skip: 2,
  cache_latents: true, cache_latents_to_disk: true, cache_text_encoder_outputs: false,
  gradient_checkpointing: true, mem_eff_attn: true, unet_only: false,
  enable_bucket: true, shuffle_caption: true, sample_every_n_epochs: 1,
  sample_prompts: '',
}

/** The service base URL, overridable through localStorage. */
function readServiceUrl(): string {
  try {
    const stored = window.localStorage.getItem('dsh.loraServiceUrl')
    if (stored !== null && stored.trim() !== '' && /^https?:\/\//u.test(stored)) return stored.trim().replace(/\/+$/u, '')
  } catch { /* storage unavailable */ }
  return DEFAULT_PORT_URL
}

/** Load the persisted training config; falls back to the SDXL preset. */
function readTrainConfig(): TrainConfig {
  try {
    const stored = window.localStorage.getItem(CFG_STORAGE_KEY)
    if (stored !== null) return { ...PRESET_SDXL_8G, ...(JSON.parse(stored) as Partial<TrainConfig>) }
  } catch { /* corrupt storage — use preset */ }
  return { ...PRESET_SDXL_8G }
}

/** One JSON call against the lora service; non-2xx throws with the detail. */
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
      else if (Array.isArray(body.detail)) detail = (body.detail[0] as { msg?: string })?.msg ?? detail
    } catch { /* keep the status code */ }
    throw new Error(detail)
  }
  return await response.json() as T
}

/** Lora section props: only the shared locale translator arrives. */
export function LoraTrainApp({ t }: { t: AppFrameProps['t'] }) {
  const [serviceUrl] = useState(readServiceUrl)
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [online, setOnline] = useState<boolean | null>(null) // null = checking
  const [tab, setTab] = useState<LoraTab>('base')

  // ---- base models ----
  const [basemodels, setBasemodels] = useState<BaseModel[]>([])
  const [basePath, setBasePath] = useState('')
  const [baseImporting, setBaseImporting] = useState(false)

  // ---- datasets ----
  const [datasets, setDatasets] = useState<DatasetInfo[]>([])
  const [selectedDataset, setSelectedDataset] = useState('')
  const [images, setImages] = useState<DatasetImage[]>([])
  const [newDatasetName, setNewDatasetName] = useState('')
  const [importFolder, setImportFolder] = useState('')
  const [datasetBusy, setDatasetBusy] = useState(false)
  const [selectedImage, setSelectedImage] = useState<DatasetImage | null>(null)
  const [captionDraft, setCaptionDraft] = useState('')
  const [captionSaved, setCaptionSaved] = useState(false)
  const [tagJobId, setTagJobId] = useState<string | null>(null)

  // ---- training ----
  const [cfg, setCfg] = useState<TrainConfig>(readTrainConfig)
  const [trainStatus, setTrainStatus] = useState<TrainStatus>({
    running: false, current_step: 0, total_steps: 0, loss: null, loss_history: [],
    speed: '', eta: '', elapsed: '', error: '', samples: [], log_tail: [],
  })
  const [trainBusy, setTrainBusy] = useState(false)
  const [trainNote, setTrainNote] = useState<{ text: string; error?: boolean } | null>(null)
  const [showDryRun, setShowDryRun] = useState(false)
  const [dryRun, setDryRun] = useState('')

  // ---- outputs / testgen / merge ----
  const [outputs, setOutputs] = useState<OutputModel[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [genForm, setGenForm] = useState({
    base: '', lora: '', prompt: '', negative: '', steps: 24, cfg: 6.0,
    width: 768, height: 768, seed: 42, weight: 1.0,
  })
  const [genJobId, setGenJobId] = useState<string | null>(null)
  const [genResult, setGenResult] = useState<{ image: string; dir: string } | null>(null)
  const [genError, setGenError] = useState<string | null>(null)
  const [mergeForm, setMergeForm] = useState({ lora: '', base: '', ratio: 1.0, output_name: '' })
  const [mergeJobId, setMergeJobId] = useState<string | null>(null)
  const [mergeNote, setMergeNote] = useState<{ text: string; error?: boolean } | null>(null)

  const baseFileInput = useRef<HTMLInputElement | null>(null)
  const imageFileInput = useRef<HTMLInputElement | null>(null)

  const onlineFlag = online === true
  const busy = status?.busy === true || trainBusy

  /** Probe service status + refresh every static list. */
  const probe = useCallback(async () => {
    try {
      const next = await api<ServiceStatus>(serviceUrl, '/api/lora/status')
      setStatus(next)
      setOnline(true)
    } catch (error) {
      if (error instanceof Error && error.message === '__offline__') {
        setOnline(false)
        setStatus(null)
      } else {
        setOnline(true)
      }
    }
  }, [serviceUrl])

  const refreshBasemodels = useCallback(async () => {
    try { setBasemodels(await api<BaseModel[]>(serviceUrl, '/api/lora/basemodels')) } catch { /* offline */ }
  }, [serviceUrl])

  const refreshDatasets = useCallback(async () => {
    try { setDatasets(await api<DatasetInfo[]>(serviceUrl, '/api/lora/datasets')) } catch { /* offline */ }
  }, [serviceUrl])

  const refreshOutputs = useCallback(async () => {
    try { setOutputs(await api<OutputModel[]>(serviceUrl, '/api/lora/outputs')) } catch { /* offline */ }
  }, [serviceUrl])

  /** Load images of a dataset; keeps the current image selection in sync. */
  const loadImages = useCallback(async (name: string) => {
    try {
      const list = await api<DatasetImage[]>(serviceUrl, `/api/lora/datasets/${encodeURIComponent(name)}/images`)
      setImages(list)
      setSelectedImage(current => current === null ? null : list.find(item => item.file === current.file) ?? null)
    } catch { /* offline */ }
  }, [serviceUrl])

  const probeTrain = useCallback(async () => {
    try {
      const next = await api<Partial<TrainStatus>>(serviceUrl, '/api/lora/train/status')
      setTrainStatus(current => ({
        ...current,
        ...next,
        loss_history: Array.isArray(next.loss_history) ? next.loss_history : current.loss_history,
        samples: Array.isArray(next.samples) ? next.samples : current.samples,
        log_tail: Array.isArray(next.log_tail) ? next.log_tail : current.log_tail,
      }))
    } catch { /* offline */ }
  }, [serviceUrl])

  // Initial load + slow status polling.
  useEffect(() => {
    void probe()
    void refreshBasemodels()
    void refreshDatasets()
    void refreshOutputs()
    const slow = window.setInterval(() => {
      void probe()
      void refreshBasemodels()
      void refreshDatasets()
      void refreshOutputs()
    }, 8000)
    return () => { window.clearInterval(slow) }
  }, [probe, refreshBasemodels, refreshDatasets, refreshOutputs])

  // Fast polling while the service is busy or a training runs.
  useEffect(() => {
    if (!onlineFlag || (!busy && !trainStatus.running)) return
    const fast = window.setInterval(() => {
      void probe()
      void probeTrain()
      if (trainStatus.running) void refreshOutputs()
    }, 1800)
    return () => { window.clearInterval(fast) }
  }, [onlineFlag, busy, trainStatus.running, probe, probeTrain, refreshOutputs])

  // One probeTrain pass on mount (so a finished training shows its tail).
  useEffect(() => {
    void probeTrain()
  }, [probeTrain])

  // Persist config edits.
  useEffect(() => {
    try { window.localStorage.setItem(CFG_STORAGE_KEY, JSON.stringify(cfg)) } catch { /* non-fatal */ }
  }, [cfg])

  // Poll a job until it settles (used by tag / merge / testgen).
  const pollJob = useCallback(async (jobId: string, onDone: (result: unknown) => void, onError: (err: string) => void): Promise<void> => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await new Promise<void>(resolve => { window.setTimeout(resolve, 2000) })
      let job: JobStatus
      try {
        job = await api<JobStatus>(serviceUrl, `/api/lora/jobs/${jobId}`)
      } catch {
        onError(t('lora.job.error').replace('{error}', '服务离线'))
        return
      }
      if (job.state === 'done') { onDone(job.result); return }
      if (job.state === 'error') { onError(job.error || t('lora.job.error').replace('{error}', '未知错误')); return }
    }
    onError(t('lora.job.error').replace('{error}', '超时'))
  }, [serviceUrl, t])

  /** Switch dataset: reload image list and clear selection. */
  const onSelectDataset = useCallback((name: string) => {
    setSelectedDataset(name)
    setSelectedImage(null)
    setCaptionDraft('')
    void loadImages(name)
  }, [loadImages])

  /** Apply a preset (keeps current base/dataset/output selections). */
  const applyPreset = useCallback((preset: TrainConfig) => {
    setCfg(current => ({
      ...preset,
      base_model: current.base_model,
      dataset: current.dataset,
      output_name: current.output_name,
    }))
  }, [])

  const setCfgField = useCallback(<K extends keyof TrainConfig>(key: K, value: TrainConfig[K]) => {
    setCfg(current => ({ ...current, [key]: value }))
  }, [])

  const copyStartCommand = useCallback(async () => {
    try { await navigator.clipboard.writeText(START_COMMAND) } catch { /* clipboard may need focus */ }
  }, [])

  // ---- base model actions ----
  const importBaseByPath = useCallback(async () => {
    if (basePath.trim() === '') return
    setBaseImporting(true)
    try {
      await api(serviceUrl, '/api/lora/basemodels/import-path', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: basePath.trim() }),
      })
      setBasePath('')
      void refreshBasemodels()
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBaseImporting(false)
    }
  }, [basePath, refreshBasemodels, serviceUrl])

  const uploadBase = useCallback(async (file: File) => {
    setBaseImporting(true)
    try {
      const form = new FormData()
      form.append('file', file)
      await api(serviceUrl, '/api/lora/basemodels/import-upload', { method: 'POST', body: form })
      void refreshBasemodels()
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setBaseImporting(false)
    }
  }, [refreshBasemodels, serviceUrl])

  const deleteBase = useCallback(async (name: string) => {
    try {
      await api(serviceUrl, `/api/lora/basemodels/${encodeURIComponent(name)}`, { method: 'DELETE' })
      void refreshBasemodels()
      if (cfg.base_model === name) setCfgField('base_model', '')
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [cfg.base_model, refreshBasemodels, serviceUrl, setCfgField])

  // ---- dataset actions ----
  const createDataset = useCallback(async () => {
    if (newDatasetName.trim() === '') return
    setDatasetBusy(true)
    try {
      await api(serviceUrl, '/api/lora/datasets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newDatasetName.trim() }),
      })
      setNewDatasetName('')
      void refreshDatasets()
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setDatasetBusy(false)
    }
  }, [newDatasetName, refreshDatasets, serviceUrl])

  const deleteDataset = useCallback(async (name: string) => {
    if (!window.confirm(t('lora.dataset.deleteConfirm'))) return
    setDatasetBusy(true)
    try {
      await api(serviceUrl, `/api/lora/datasets/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (selectedDataset === name) { setSelectedDataset(''); setImages([]); setSelectedImage(null) }
      if (cfg.dataset === name) setCfgField('dataset', '')
      void refreshDatasets()
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setDatasetBusy(false)
    }
  }, [cfg.dataset, refreshDatasets, selectedDataset, serviceUrl, setCfgField, t])

  const importFolderInto = useCallback(async () => {
    if (selectedDataset === '' || importFolder.trim() === '') return
    setDatasetBusy(true)
    try {
      await api(serviceUrl, `/api/lora/datasets/${encodeURIComponent(selectedDataset)}/import-folder`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: importFolder.trim() }),
      })
      setImportFolder('')
      void refreshDatasets()
      void loadImages(selectedDataset)
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setDatasetBusy(false)
    }
  }, [importFolder, loadImages, refreshDatasets, selectedDataset, serviceUrl])

  const uploadImages = useCallback(async (files: FileList | File[]) => {
    if (selectedDataset === '' || files.length === 0) return
    setDatasetBusy(true)
    try {
      const form = new FormData()
      for (const file of Array.from(files)) form.append('files', file)
      await api(serviceUrl, `/api/lora/datasets/${encodeURIComponent(selectedDataset)}/upload`, {
        method: 'POST', body: form,
      })
      void refreshDatasets()
      void loadImages(selectedDataset)
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setDatasetBusy(false)
    }
  }, [loadImages, refreshDatasets, selectedDataset, serviceUrl])

  const saveCaption = useCallback(async () => {
    if (selectedDataset === '' || selectedImage === null) return
    try {
      await api(serviceUrl, `/api/lora/datasets/${encodeURIComponent(selectedDataset)}/images/${encodeURIComponent(selectedImage.file)}/caption`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caption: captionDraft }),
      })
      setCaptionSaved(true)
      window.setTimeout(() => setCaptionSaved(false), 1500)
      void loadImages(selectedDataset)
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [captionDraft, loadImages, selectedDataset, selectedImage, serviceUrl])

  const removeImage = useCallback(async (file: string) => {
    if (selectedDataset === '') return
    try {
      await api(serviceUrl, `/api/lora/datasets/${encodeURIComponent(selectedDataset)}/images/${encodeURIComponent(file)}`, { method: 'DELETE' })
      if (selectedImage?.file === file) { setSelectedImage(null); setCaptionDraft('') }
      void loadImages(selectedDataset)
      void refreshDatasets()
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [loadImages, refreshDatasets, selectedDataset, selectedImage, serviceUrl])

  const runTag = useCallback(async () => {
    if (selectedDataset === '') return
    setTagJobId('pending')
    try {
      const res = await api<{ job_id: string }>(serviceUrl, `/api/lora/datasets/${encodeURIComponent(selectedDataset)}/tag`, { method: 'POST' })
      setTagJobId(res.job_id)
      void pollJob(res.job_id, () => {
        setTagJobId(null)
        void loadImages(selectedDataset)
        void refreshDatasets()
      }, (err) => {
        setTagJobId(null)
        setTrainNote({ text: err, error: true })
      })
    } catch (error) {
      setTagJobId(null)
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [loadImages, pollJob, refreshDatasets, selectedDataset, serviceUrl])

  // ---- training actions ----
  const previewCommand = useCallback(async () => {
    setTrainBusy(true)
    setTrainNote(null)
    try {
      const body = { cfg: { ...cfg, base_model: resolveBasePath(cfg.base_model, basemodels), dataset: cfg.dataset }, dry_run: true }
      const res = await api<{ argv: string }>(serviceUrl, '/api/lora/train/start', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      setDryRun(res.argv)
      setShowDryRun(true)
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setTrainBusy(false)
    }
  }, [basemodels, cfg, serviceUrl])

  const startTraining = useCallback(async () => {
    if (!onlineFlag) { setTrainNote({ text: t('lora.train.needService'), error: true }); return }
    if (cfg.base_model === '') { setTrainNote({ text: t('lora.train.needBase'), error: true }); return }
    if (cfg.dataset === '') { setTrainNote({ text: t('lora.train.needDataset'), error: true }); return }
    if (cfg.output_name.trim() === '') { setTrainNote({ text: t('lora.train.needOutputName'), error: true }); return }
    setTrainBusy(true)
    setTrainNote(null)
    setShowDryRun(false)
    try {
      const body = { cfg: { ...cfg, base_model: resolveBasePath(cfg.base_model, basemodels), dataset: cfg.dataset, output_name: cfg.output_name.trim() } }
      await api(serviceUrl, '/api/lora/train/start', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      setTrainNote({ text: t('lora.train.started') })
      void probeTrain()
    } catch (error) {
      setTrainNote({ text: error instanceof Error && error.message === '__offline__'
        ? t('lora.train.needService')
        : t('lora.train.error').replace('{error}', error instanceof Error ? error.message : String(error)), error: true })
    } finally {
      setTrainBusy(false)
    }
  }, [basemodels, cfg, onlineFlag, probeTrain, serviceUrl, t])

  const stopTraining = useCallback(async () => {
    setTrainBusy(true)
    try {
      await api(serviceUrl, '/api/lora/train/stop', { method: 'POST' })
      setTrainNote({ text: t('lora.train.stopped') })
      void probeTrain()
      void refreshOutputs()
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    } finally {
      setTrainBusy(false)
    }
  }, [probeTrain, refreshOutputs, serviceUrl, t])

  // ---- outputs actions ----
  const copyToComfy = useCallback(async (name: string) => {
    try {
      await api(serviceUrl, `/api/lora/outputs/${encodeURIComponent(name)}/copy-to-comfy`, { method: 'POST' })
      setCopied(name)
      window.setTimeout(() => setCopied(current => current === name ? null : current), 1800)
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [serviceUrl])

  const deleteOutput = useCallback(async (name: string) => {
    if (!window.confirm(t('lora.output.deleteConfirm'))) return
    try {
      await api(serviceUrl, `/api/lora/outputs/${encodeURIComponent(name)}`, { method: 'DELETE' })
      void refreshOutputs()
    } catch (error) {
      setTrainNote({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [refreshOutputs, serviceUrl, t])

  const runTestgen = useCallback(async () => {
    setGenError(null)
    setGenResult(null)
    setGenJobId('pending')
    try {
      const res = await api<{ job_id: string }>(serviceUrl, '/api/lora/testgen', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base_model: resolveBasePath(genForm.base, basemodels),
          lora: resolveOutputPath(genForm.lora),
          prompt: genForm.prompt,
          negative_prompt: genForm.negative,
          steps: genForm.steps, cfg_scale: genForm.cfg,
          width: genForm.width, height: genForm.height,
          seed: genForm.seed, weight: genForm.weight,
        }),
      })
      setGenJobId(res.job_id)
      void pollJob(res.job_id, (result) => {
        setGenJobId(null)
        setGenResult(result as { image: string; dir: string })
      }, (err) => {
        setGenJobId(null)
        setGenError(t('lora.output.testgen.error').replace('{error}', err))
      })
    } catch (error) {
      setGenJobId(null)
      setGenError(t('lora.output.testgen.error').replace('{error}', error instanceof Error ? error.message : String(error)))
    }
  }, [basemodels, genForm, outputs, pollJob, serviceUrl, t])

  const runMerge = useCallback(async () => {
    setMergeNote(null)
    setMergeJobId('pending')
    try {
      const res = await api<{ job_id: string }>(serviceUrl, '/api/lora/merge', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          base_model: resolveBasePath(mergeForm.base, basemodels),
          lora: resolveOutputPath(mergeForm.lora),
          output_name: mergeForm.output_name.trim(),
          ratio: mergeForm.ratio,
        }),
      })
      setMergeJobId(res.job_id)
      void pollJob(res.job_id, () => {
        setMergeJobId(null)
        setMergeNote({ text: t('lora.output.merge.done').replace('{name}', mergeForm.output_name.trim()) })
        void refreshOutputs()
      }, (err) => {
        setMergeJobId(null)
        setMergeNote({ text: t('lora.output.merge.error').replace('{error}', err), error: true })
      })
    } catch (error) {
      setMergeJobId(null)
      setMergeNote({ text: t('lora.output.merge.error').replace('{error}', error instanceof Error ? error.message : String(error)), error: true })
    }
  }, [basemodels, mergeForm, outputs, pollJob, refreshOutputs, serviceUrl, t])

  const statusKind = online === null ? 'checking' : !onlineFlag ? 'offline' : busy ? 'busy' : 'online'
  const statusLabel = online === null
    ? t('lora.status.checking')
    : !onlineFlag ? t('lora.status.offline') : busy ? t('lora.status.busy') : t('lora.status.online')

  const lossSeries = useMemo(() => {
    if (trainStatus.loss_history.length < 2) return []
    // decimate to at most 240 points for the SVG
    const step = Math.max(1, Math.ceil(trainStatus.loss_history.length / 240))
    const out: Array<{ step: number; loss: number }> = []
    for (let i = 0; i < trainStatus.loss_history.length; i += step) out.push(trainStatus.loss_history[i]!)
    return out
  }, [trainStatus.loss_history])

  return (
    <div className={css.pane} role="region" aria-label={t('lora.title')}>
      <div className={css.column}>
        {/* Header: identity + live service state + recovery actions */}
        <div className={css.header}>
          <span className={css.headerIcon}><IconChipOutline16 size={22} /></span>
          <div className={css.headerText}>
            <h2 className={css.title}>{t('lora.title')}</h2>
            <p className={css.subtitle}>{t('lora.subtitle')}</p>
          </div>
          <div className={css.headerActions}>
            <span className={css.statusPill}>
              <span className={css.dot} data-kind={statusKind} />
              {statusLabel}
              {status?.gpu?.name !== undefined && ` · ${status.gpu.name}`}
            </span>
            {status?.gpu?.vram_total_gb !== undefined && (
              <span className={css.statusPill}>
                {t('lora.gpu').replace('{used}', String((status.gpu.vram_used_gb ?? 0).toFixed(1))).replace('{total}', String(status.gpu.vram_total_gb.toFixed(1)))}
              </span>
            )}
            <Button size="sm" icon={<IconRefreshOutline16 size={16} />} onClick={() => { void probe() }}>
              {t('retry')}
            </Button>
            {!onlineFlag && online !== null && (
              <Button size="sm" variant="primary" icon={<IconDownloadOutline16 size={16} />} onClick={() => { void copyStartCommand() }}>
                {t('lora.copyStartCmd')}
              </Button>
            )}
          </div>
        </div>
        {!onlineFlag && online !== null && (
          <div className={css.card}>
            <p className={css.hint}>{t('lora.startHint')}</p>
            <div className={css.mono}>{START_COMMAND}</div>
          </div>
        )}

        {/* Workbench tabs */}
        <div className={css.segmentRow}>
          {([
            ['base', IconFolderOpenOutline16, 'lora.tab.base'],
            ['dataset', IconArchiveOutline20, 'lora.tab.dataset'],
            ['train', IconSettingsOutline16, 'lora.tab.train'],
            ['output', IconChipOutline16, 'lora.tab.output'],
          ] as const).map(([id, Icon, key]) => (
            <button
              key={id}
              type="button"
              className={css.segment}
              data-active={tab === id || undefined}
              data-tone={tab === id ? 'primary' : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={15} />
              <span>{t(key)}</span>
            </button>
          ))}
        </div>

        {trainNote !== null && (
          <div className={css.card} data-note={trainNote.error ? 'error' : undefined}>
            <span className={css.generateNote} data-error={trainNote.error || undefined}>{trainNote.text}</span>
          </div>
        )}

        {/* ============ TAB: base models ============ */}
        {tab === 'base' && (
          <div className={css.card}>
            <div className={css.cardHead}>
              <h3 className={css.cardTitle}>{t('lora.base.card')}</h3>
              <div className={css.cardHeadActions}>
                <Button size="sm" icon={<IconRefreshOutline16 size={16} />} onClick={() => { void refreshBasemodels() }}>
                  {t('lora.base.refresh')}
                </Button>
              </div>
            </div>
            <div className={css.row}>
              <input
                type="text"
                className={css.urlInput}
                placeholder={t('lora.base.pathPlaceholder')}
                value={basePath}
                onChange={event => setBasePath(event.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                icon={baseImporting ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconDownloadOutline16 size={16} />}
                disabled={basePath.trim() === '' || baseImporting}
                onClick={() => { void importBaseByPath() }}
              >
                {baseImporting ? t('lora.base.importing') : t('lora.base.importPath')}
              </Button>
              <input
                ref={baseFileInput}
                type="file"
                accept=".safetensors,.ckpt"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file !== undefined) void uploadBase(file)
                  event.target.value = ''
                }}
              />
              <Button
                size="sm"
                icon={<IconPaperclipOutline16 size={16} />}
                disabled={baseImporting}
                onClick={() => { baseFileInput.current?.click() }}
              >
                {t('lora.base.importUpload')}
              </Button>
            </div>
            {basemodels.length === 0
              ? <div className={css.emptyBox}>{t('lora.base.empty')}</div>
              : (
                <div className={css.baseList}>
                  {basemodels.map(model => (
                    <div className={css.baseItem} key={model.name} data-selected={cfg.base_model === model.name || undefined}>
                      <span className={css.familyBadge} data-family={model.family}>
                        {t(`lora.base.family.${model.family}`)}
                      </span>
                      <span className={css.historyMeta} title={model.path}>{model.name}</span>
                      <span className={css.fileName}>
                        {t('lora.base.size').replace('{size}', model.size_gb.toFixed(2))}
                        {model.managed ? ` · ${t('lora.base.managed')}` : ''}
                      </span>
                      <Button
                        size="sm"
                        {...(cfg.base_model === model.name ? { variant: 'primary' as const, icon: <IconCheckOutline16 size={16} /> } : {})}
                        onClick={() => setCfgField('base_model', model.name)}
                      >
                        {cfg.base_model === model.name ? t('lora.base.using') : t('lora.base.use')}
                      </Button>
                      <Button size="sm" icon={<IconTrashOutline16 size={16} />} onClick={() => { void deleteBase(model.name) }}>
                        {t('lora.base.delete')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
          </div>
        )}

        {/* ============ TAB: datasets ============ */}
        {tab === 'dataset' && (
          <>
            <div className={css.card}>
              <div className={css.cardHead}>
                <h3 className={css.cardTitle}>{t('lora.dataset.card')}</h3>
                <div className={css.cardHeadActions}>
                  <input
                    type="text"
                    className={css.urlInput}
                    placeholder={t('lora.dataset.namePlaceholder')}
                    value={newDatasetName}
                    onChange={event => setNewDatasetName(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlusOutline16 size={16} />}
                    disabled={newDatasetName.trim() === '' || datasetBusy}
                    onClick={() => { void createDataset() }}
                  >
                    {t('lora.dataset.create')}
                  </Button>
                </div>
              </div>
              {datasets.length === 0
                ? <div className={css.emptyBox}>{t('lora.dataset.empty')}</div>
                : (
                  <div className={css.datasetList}>
                    {datasets.map(item => (
                      <div className={css.datasetItem} key={item.name} data-selected={selectedDataset === item.name || undefined}>
                        <span className={css.historyMeta}>{item.name}</span>
                        <span className={css.fileName}>{t('lora.dataset.images').replace('{count}', String(item.images)).replace('{caps}', String(item.captioned))}</span>
                        <Button
                          size="sm"
                          {...(selectedDataset === item.name ? { variant: 'primary' as const, icon: <IconCheckOutline16 size={16} /> } : {})}
                          onClick={() => { onSelectDataset(item.name); setCfgField('dataset', item.name) }}
                        >
                          {cfg.dataset === item.name ? t('lora.dataset.using') : t('lora.dataset.select')}
                        </Button>
                        <Button size="sm" icon={<IconTrashOutline16 size={16} />} onClick={() => { void deleteDataset(item.name) }}>
                          {t('lora.dataset.delete')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
            </div>

            {selectedDataset !== '' && (
              <>
                <div className={css.card}>
                  <div className={css.cardHead}>
                    <h3 className={css.cardTitle}>{selectedDataset}</h3>
                    <div className={css.cardHeadActions}>
                      <input
                        type="text"
                        className={css.urlInput}
                        placeholder={t('lora.dataset.folderPlaceholder')}
                        value={importFolder}
                        onChange={event => setImportFolder(event.target.value)}
                      />
                      <Button
                        size="sm"
                        icon={datasetBusy ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconFolderOpenOutline16 size={16} />}
                        disabled={importFolder.trim() === '' || datasetBusy}
                        onClick={() => { void importFolderInto() }}
                      >
                        {datasetBusy ? t('lora.dataset.importing') : t('lora.dataset.importFolder')}
                      </Button>
                      <input
                        ref={imageFileInput}
                        type="file"
                        accept="image/*,.jpg,.jpeg,.png,.webp,.bmp"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(event) => {
                          const files = event.target.files
                          if (files !== null && files.length > 0) void uploadImages(files)
                          event.target.value = ''
                        }}
                      />
                      <Button
                        size="sm"
                        icon={datasetBusy ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconPaperclipOutline16 size={16} />}
                        disabled={datasetBusy}
                        onClick={() => { imageFileInput.current?.click() }}
                      >
                        {datasetBusy ? t('lora.dataset.uploading') : t('lora.dataset.upload')}
                      </Button>
                      <Button
                        size="sm"
                        icon={tagJobId !== null ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconEditOutline16 size={16} />}
                        disabled={tagJobId !== null || images.length === 0}
                        onClick={() => { void runTag() }}
                      >
                        {tagJobId !== null ? t('lora.dataset.tagging') : t('lora.dataset.tag')}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className={css.card}>
                  <div className={css.cardHead}>
                    <h3 className={css.cardTitle}>{t('lora.dataset.captionTitle')}</h3>
                    {selectedImage !== null && (
                      <div className={css.cardHeadActions}>
                        <Button size="sm" icon={<IconTrashOutline16 size={16} />} onClick={() => { void removeImage(selectedImage.file) }}>
                          {t('lora.dataset.removeImage')}
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className={css.datasetWorkbench}>
                    <div className={css.imageGrid}>
                      {images.map(item => (
                        <button
                          key={item.file}
                          type="button"
                          className={css.imageTile}
                          data-active={selectedImage?.file === item.file || undefined}
                          onClick={() => { setSelectedImage(item); setCaptionDraft(item.caption); setCaptionSaved(false) }}
                          title={item.file}
                        >
                          <img src={`${serviceUrl}/api/lora/datasets/${encodeURIComponent(selectedDataset)}/images/${encodeURIComponent(item.file)}/thumb`} alt={item.file} loading="lazy" />
                          <span className={css.imageMeta}>{item.width}×{item.height}</span>
                        </button>
                      ))}
                    </div>
                    <div className={css.captionEditor}>
                      {selectedImage === null
                        ? <div className={css.emptyBox}>{t('lora.dataset.noneSelected')}</div>
                        : (
                          <>
                            <span className={css.fileName}>{selectedImage.file}</span>
                            <textarea
                              className={css.textarea}
                              value={captionDraft}
                              placeholder={t('lora.dataset.captionPlaceholder')}
                              onChange={event => setCaptionDraft(event.target.value)}
                            />
                            <div className={css.row}>
                              <Button size="sm" variant="primary" icon={<IconSendOutline16 size={16} />} onClick={() => { void saveCaption() }}>
                                {captionSaved ? t('lora.dataset.captionSaved') : t('lora.dataset.saveCaption')}
                              </Button>
                              <a href={`${serviceUrl}/api/lora/datasets/${encodeURIComponent(selectedDataset)}/images/${encodeURIComponent(selectedImage.file)}/full`} target="_blank" rel="noreferrer">
                                <Button size="sm" icon={<IconFolderOpenOutline16 size={16} />}>{t('lora.dataset.viewFull')}</Button>
                              </a>
                            </div>
                          </>
                        )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* ============ TAB: training ============ */}
        {tab === 'train' && (
          <>
            <div className={css.card}>
              <div className={css.cardHead}>
                <h3 className={css.cardTitle}>{t('lora.train.card')}</h3>
                <div className={css.cardHeadActions}>
                  <span className={css.sliderLabel} style={{ width: 'auto' }}>{t('lora.train.preset')}</span>
                  <Button size="sm" onClick={() => applyPreset(PRESET_SDXL_8G)}>{t('lora.train.preset.sdxl')}</Button>
                  <Button size="sm" onClick={() => applyPreset(PRESET_SD15)}>{t('lora.train.preset.sd15')}</Button>
                </div>
              </div>

              <div className={css.formGrid}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.baseModel')}</span>
                  <select className={css.select} value={cfg.base_model} onChange={event => setCfgField('base_model', event.target.value)}>
                    <option value="">—</option>
                    {basemodels.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.dataset')}</span>
                  <select className={css.select} value={cfg.dataset} onChange={event => setCfgField('dataset', event.target.value)}>
                    <option value="">—</option>
                    {datasets.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.outputName')}</span>
                  <input type="text" className={css.numberInput} style={{ width: '100%' }} placeholder={t('lora.train.outputNamePlaceholder')} value={cfg.output_name} onChange={event => setCfgField('output_name', event.target.value)} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.dim')}</span>
                  <input type="number" className={css.numberInput} value={cfg.network_dim} min={1} max={256} onChange={event => setCfgField('network_dim', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.alpha')}</span>
                  <input type="number" className={css.numberInput} value={cfg.network_alpha} min={1} max={256} onChange={event => setCfgField('network_alpha', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.lr')}</span>
                  <input type="number" className={css.numberInput} value={cfg.learning_rate} min={0} step={1e-5} onChange={event => setCfgField('learning_rate', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.scheduler')}</span>
                  <select className={css.select} value={cfg.lr_scheduler} onChange={event => setCfgField('lr_scheduler', event.target.value)}>
                    {LR_SCHEDULERS.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.warmup')}</span>
                  <input type="number" className={css.numberInput} value={cfg.lr_warmup_steps} min={0} onChange={event => setCfgField('lr_warmup_steps', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.epochs')}</span>
                  <input type="number" className={css.numberInput} value={cfg.max_train_epochs} min={1} onChange={event => setCfgField('max_train_epochs', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.repeats')}</span>
                  <input type="number" className={css.numberInput} value={cfg.num_repeats} min={1} onChange={event => setCfgField('num_repeats', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.resolution')}</span>
                  <input type="number" className={css.numberInput} value={cfg.resolution} min={256} step={64} onChange={event => setCfgField('resolution', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.batch')}</span>
                  <input type="number" className={css.numberInput} value={cfg.train_batch_size} min={1} onChange={event => setCfgField('train_batch_size', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.gradAccum')}</span>
                  <input type="number" className={css.numberInput} value={cfg.gradient_accumulation_steps} min={1} onChange={event => setCfgField('gradient_accumulation_steps', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.maxToken')}</span>
                  <input type="number" className={css.numberInput} value={cfg.max_token_length} min={75} max={225} onChange={event => setCfgField('max_token_length', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.optimizer')}</span>
                  <select className={css.select} value={cfg.optimizer_type} onChange={event => setCfgField('optimizer_type', event.target.value)}>
                    {OPTIMIZERS.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.mixedPrecision')}</span>
                  <select className={css.select} value={cfg.mixed_precision} onChange={event => setCfgField('mixed_precision', event.target.value)}>
                    {MIXED_PRECISIONS.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.savePrecision')}</span>
                  <select className={css.select} value={cfg.save_precision} onChange={event => setCfgField('save_precision', event.target.value)}>
                    {MIXED_PRECISIONS.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.saveEvery')}</span>
                  <input type="number" className={css.numberInput} value={cfg.save_every_n_epochs} min={1} onChange={event => setCfgField('save_every_n_epochs', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.seed')}</span>
                  <input type="number" className={css.numberInput} value={cfg.seed} onChange={event => setCfgField('seed', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.minSnr')}</span>
                  <input type="number" className={css.numberInput} value={cfg.min_snr_gamma} min={0} onChange={event => setCfgField('min_snr_gamma', Number(event.target.value))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.noiseOffset')}</span>
                  <input type="number" className={css.numberInput} value={cfg.noise_offset} min={0} step={0.01} onChange={event => setCfgField('noise_offset', Number(event.target.value))} />
                </label>
                {cfg.family === 'sd15' && (
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('lora.train.clipSkip')}</span>
                    <input type="number" className={css.numberInput} value={cfg.clip_skip} min={1} max={12} onChange={event => setCfgField('clip_skip', Number(event.target.value))} />
                  </label>
                )}
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.train.sampleEvery')}</span>
                  <input type="number" className={css.numberInput} value={cfg.sample_every_n_epochs} min={1} onChange={event => setCfgField('sample_every_n_epochs', Number(event.target.value))} />
                </label>
              </div>

              <div className={css.checkboxGrid}>
                {([
                  ['cache_latents', 'lora.train.option.cacheLatents'],
                  ['cache_latents_to_disk', 'lora.train.option.cacheLatentsDisk'],
                  ['cache_text_encoder_outputs', 'lora.train.option.cacheText'],
                  ['gradient_checkpointing', 'lora.train.option.gradCkpt'],
                  ['mem_eff_attn', 'lora.train.option.memEffAttn'],
                  ['unet_only', 'lora.train.option.unetOnly'],
                  ['enable_bucket', 'lora.train.option.bucket'],
                  ['shuffle_caption', 'lora.train.option.shuffle'],
                ] as const).map(([key, label]) => (
                  <label className={css.checkboxRow} key={key}>
                    <input
                      type="checkbox"
                      checked={cfg[key]}
                      onChange={event => setCfgField(key, event.target.checked)}
                    />
                    {t(label)}
                  </label>
                ))}
              </div>

              <label className={css.field}>
                <span className={css.fieldLabel}>{t('lora.train.samplePrompt')}</span>
                <textarea
                  className={css.textarea}
                  placeholder={t('lora.train.samplePromptPlaceholder')}
                  value={cfg.sample_prompts}
                  onChange={event => setCfgField('sample_prompts', event.target.value)}
                />
              </label>

              <div className={css.generateRow}>
                <Button
                  variant="primary"
                  disabled={!onlineFlag || trainStatus.running || trainBusy}
                  icon={trainBusy ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconPlayOutline16 size={16} />}
                  onClick={() => { void startTraining() }}
                >
                  {t('lora.train.start')}
                </Button>
                <Button
                  variant="outline"
                  disabled={!trainStatus.running || trainBusy}
                  icon={trainBusy ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconStopFill16 size={16} />}
                  onClick={() => { void stopTraining() }}
                >
                  {trainStatus.running ? t('lora.train.stop') : t('lora.train.stopped')}
                </Button>
                <Button size="sm" icon={<IconFileOutline16 size={16} />} disabled={!onlineFlag || trainBusy || trainStatus.running} onClick={() => { void previewCommand() }}>
                  {t('lora.train.dryRun')}
                </Button>
              </div>
              {showDryRun && dryRun !== '' && (
                <div className={css.mono} style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto' }}>{dryRun}</div>
              )}
            </div>

            {/* Live training monitor */}
            <div className={css.card}>
              <div className={css.cardHead}>
                <h3 className={css.cardTitle}>{t('lora.progress.card')}</h3>
                {trainStatus.running && (
                  <div className={css.cardHeadActions}>
                    <span className={css.statusPill} data-busy>
                      {t('lora.progress.step')}: {trainStatus.current_step}/{trainStatus.total_steps || '…'}
                    </span>
                    {trainStatus.loss !== null && (
                      <span className={css.statusPill}>{t('lora.progress.loss')}: {trainStatus.loss.toFixed(4)}</span>
                    )}
                    {trainStatus.speed !== '' && <span className={css.statusPill}>{t('lora.progress.speed')}: {trainStatus.speed}</span>}
                    {trainStatus.eta !== '' && <span className={css.statusPill}>{t('lora.progress.eta')}: {trainStatus.eta}</span>}
                    {trainStatus.elapsed !== '' && <span className={css.statusPill}>{t('lora.progress.elapsed')}: {trainStatus.elapsed}</span>}
                  </div>
                )}
              </div>
              {!trainStatus.running && trainStatus.total_steps === 0
                ? <div className={css.emptyBox}>{t('lora.progress.idle')}</div>
                : (
                  <>
                    {trainStatus.error !== '' && (
                      <p className={css.hint} style={{ color: '#e5484d' }}>{t('lora.progress.error').replace('{error}', trainStatus.error)}</p>
                    )}
                    {lossSeries.length >= 2 && (
                      <LossChart series={lossSeries} />
                    )}
                    {trainStatus.samples.length > 0 && (
                      <>
                        <h4 className={css.cardTitle}>{t('lora.progress.samples')}</h4>
                        <div className={css.sampleGrid}>
                          {trainStatus.samples.map(name => (
                            <img key={name} className={css.sampleImg} src={`${serviceUrl}/api/lora/train/sample-image/${encodeURIComponent(name)}`} alt={name} loading="lazy" />
                          ))}
                        </div>
                      </>
                    )}
                    {trainStatus.samples.length === 0 && trainStatus.running && (
                      <p className={css.hint}>{t('lora.progress.samplesEmpty')}</p>
                    )}
                    <h4 className={css.cardTitle}>{t('lora.progress.log')}</h4>
                    <pre className={css.logView}>{trainStatus.log_tail.join('\n')}</pre>
                  </>
                )}
            </div>
          </>
        )}

        {/* ============ TAB: outputs ============ */}
        {tab === 'output' && (
          <>
            <div className={css.card}>
              <div className={css.cardHead}>
                <h3 className={css.cardTitle}>{t('lora.output.card')}</h3>
                <div className={css.cardHeadActions}>
                  <Button size="sm" icon={<IconRefreshOutline16 size={16} />} onClick={() => { void refreshOutputs() }}>
                    {t('lora.base.refresh')}
                  </Button>
                </div>
              </div>
              {outputs.length === 0
                ? <div className={css.emptyBox}>{t('lora.output.empty')}</div>
                : (
                  <div className={css.baseList}>
                    {outputs.map(model => (
                      <div className={css.baseItem} key={model.name}>
                        <IconChipOutline16 size={16} />
                        <span className={css.historyMeta} title={model.name}>{model.name}</span>
                        <span className={css.fileName}>{model.size_mb.toFixed(1)} MB</span>
                        <Button
                          size="sm"
                          icon={copied === model.name ? <IconCheckOutline16 size={16} /> : <IconDownloadOutline16 size={16} />}
                          onClick={() => { void copyToComfy(model.name) }}
                        >
                          {copied === model.name ? t('lora.output.copied') : t('lora.output.copyComfy')}
                        </Button>
                        <Button size="sm" icon={<IconTrashOutline16 size={16} />} onClick={() => { void deleteOutput(model.name) }}>
                          {t('lora.output.delete')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
            </div>

            {/* Test generation */}
            <div className={css.card}>
              <div className={css.cardHead}>
                <h3 className={css.cardTitle}>{t('lora.output.testgen')}</h3>
              </div>
              <div className={css.formGrid}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.output.testgen.base')}</span>
                  <select className={css.select} value={genForm.base} onChange={event => setGenForm(current => ({ ...current, base: event.target.value }))}>
                    <option value="">—</option>
                    {basemodels.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.output.testgen.lora')}</span>
                  <select className={css.select} value={genForm.lora} onChange={event => setGenForm(current => ({ ...current, lora: event.target.value }))}>
                    <option value="">—</option>
                    {outputs.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                </label>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span className={css.fieldLabel}>{t('lora.output.testgen.prompt')}</span>
                  <input type="text" className={css.urlInput} style={{ width: '100%' }} value={genForm.prompt} onChange={event => setGenForm(current => ({ ...current, prompt: event.target.value }))} />
                </label>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span className={css.fieldLabel}>{t('lora.output.testgen.negative')}</span>
                  <input type="text" className={css.urlInput} style={{ width: '100%' }} value={genForm.negative} onChange={event => setGenForm(current => ({ ...current, negative: event.target.value }))} />
                </label>
                {([
                  ['steps', 'lora.output.testgen.steps', 1, 150, 1],
                  ['cfg', 'lora.output.testgen.cfg', 1, 30, 0.5],
                  ['width', 'lora.output.testgen.width', 256, 1536, 64],
                  ['height', 'lora.output.testgen.height', 256, 1536, 64],
                  ['seed', 'lora.output.testgen.seed', -1, 2_147_483_647, 1],
                  ['weight', 'lora.output.testgen.weight', 0, 2, 0.05],
                ] as const).map(([key, label, min, max, step]) => (
                  <label className={css.field} key={key}>
                    <span className={css.fieldLabel}>{t(label)}</span>
                    <input type="number" className={css.numberInput} value={genForm[key]} min={min} max={max} step={step} onChange={event => setGenForm(current => ({ ...current, [key]: Number(event.target.value) }))} />
                  </label>
                ))}
              </div>
              <div className={css.generateRow}>
                <Button
                  variant="primary"
                  disabled={genJobId !== null || !onlineFlag || genForm.base === '' || genForm.lora === '' || genForm.prompt.trim() === ''}
                  icon={genJobId !== null ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconPlayOutline16 size={16} />}
                  onClick={() => { void runTestgen() }}
                >
                  {genJobId !== null ? t('lora.output.testgen.generating') : t('lora.output.testgen.generate')}
                </Button>
              </div>
              {genError !== null && <p className={css.hint} style={{ color: '#e5484d' }}>{genError}</p>}
              {genResult !== null && (
                <div className={css.card} data-inner>
                  <h4 className={css.cardTitle}>{t('lora.output.testgen.result')}</h4>
                  <img
                    className={css.genResultImg}
                    src={`${serviceUrl}/api/lora/preview/${encodeURIComponent(genResult.dir)}/${encodeURIComponent(genResult.image)}`}
                    alt={genForm.prompt}
                  />
                  <p className={css.fileName}>{genForm.prompt}</p>
                </div>
              )}
            </div>

            {/* Merge LoRA into base model */}
            <div className={css.card}>
              <div className={css.cardHead}>
                <h3 className={css.cardTitle}>{t('lora.output.merge')}</h3>
              </div>
              <p className={css.hint}>{t('lora.output.merge.hint')}</p>
              <div className={css.formGrid}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.output.merge.lora')}</span>
                  <select className={css.select} value={mergeForm.lora} onChange={event => setMergeForm(current => ({ ...current, lora: event.target.value }))}>
                    <option value="">—</option>
                    {outputs.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.output.merge.base')}</span>
                  <select className={css.select} value={mergeForm.base} onChange={event => setMergeForm(current => ({ ...current, base: event.target.value }))}>
                    <option value="">—</option>
                    {basemodels.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.output.merge.ratio')}</span>
                  <input type="number" className={css.numberInput} value={mergeForm.ratio} min={0} max={2} step={0.05} onChange={event => setMergeForm(current => ({ ...current, ratio: Number(event.target.value) }))} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('lora.output.merge.outputName')}</span>
                  <input type="text" className={css.numberInput} style={{ width: '100%' }} value={mergeForm.output_name} onChange={event => setMergeForm(current => ({ ...current, output_name: event.target.value }))} />
                </label>
              </div>
              <div className={css.generateRow}>
                <Button
                  variant="primary"
                  disabled={mergeJobId !== null || !onlineFlag || mergeForm.lora === '' || mergeForm.base === '' || mergeForm.output_name.trim() === ''}
                  icon={mergeJobId !== null ? <IconLoadingOutline16 size={16} className={css.spin} /> : <IconDownloadOutline16 size={16} />}
                  onClick={() => { void runMerge() }}
                >
                  {mergeJobId !== null ? t('lora.output.merge.merging') : t('lora.output.merge.start')}
                </Button>
              </div>
              {mergeNote !== null && (
                <span className={css.generateNote} data-error={mergeNote.error || undefined}>{mergeNote.text}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Resolve a base-model display name back to its absolute path. */
function resolveBasePath(name: string, basemodels: BaseModel[]): string {
  const found = basemodels.find(model => model.name === name)
  return found?.path ?? name
}

/** LoRA references: bare output names are resolved server-side against the
 *  output dir; absolute paths pass through untouched. */
function resolveOutputPath(name: string): string {
  return name
}

/** Minimal SVG loss chart over the training step history. */
function LossChart({ series }: { series: Array<{ step: number; loss: number }> }) {
  const width = 640
  const height = 120
  const pad = 8
  const minStep = series[0]?.step ?? 0
  const maxStep = series[series.length - 1]?.step ?? minStep + 1
  const maxLoss = Math.max(...series.map(p => p.loss), 1e-6)
  const points = series.map(p => {
    const x = pad + (maxStep === minStep ? 0 : (p.step - minStep) / (maxStep - minStep)) * (width - pad * 2)
    const y = pad + (1 - p.loss / maxLoss) * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg className={css.chart} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="loss">
      <polyline points={points} fill="none" stroke="var(--dsw-alias-button-primary-fill, #3b82f6)" strokeWidth="1.5" />
    </svg>
  )
}
