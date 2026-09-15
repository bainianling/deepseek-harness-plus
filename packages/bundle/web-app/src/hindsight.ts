/**
 * Local Hindsight daemon lifecycle for the Web knowledge routes.
 * The browser can request a start, but it never supplies a command, profile, or
 * path; those values come from the composed Web configuration.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** States exposed by the local daemon controller. */
export type HindsightLifecycleState = 'online' | 'offline' | 'starting' | 'error'

/** Error classes returned by the controller without exposing process details. */
export type HindsightStartErrorCode = 'executable-missing' | 'spawn-failed' | 'process-failed' | 'timeout'

/** Configuration needed to start and probe one local Hindsight profile. */
export interface HindsightLifecycleConfig {
  hindsightUrl: string
  hindsightProfile: string
  hindsightCommand: string
  hindsightStartTimeoutMs: number
  knowledgeTimeoutMs: number
}

/** JSON-safe lifecycle state used by the status route. */
export interface HindsightLifecycleSnapshot {
  status: HindsightLifecycleState
  errorCode: HindsightStartErrorCode | null
  message: string | null
  startedAt: string | null
}

const LOG_TAIL_MAX_CHARS = 2_400
const LOG_TAIL_MAX_LINES = 12
const LOG_READ_MAX_BYTES = 64 * 1024
const POLL_INTERVAL_MS = 1_000
const HINDSIGHT_ENV_KEYS = [
  'HINDSIGHT_API_LLM_API_KEY',
  'HINDSIGHT_API_LLM_BASE_URL',
  'HINDSIGHT_API_LLM_MODEL',
  'HINDSIGHT_API_LLM_PROVIDER',
  'HINDSIGHT_API_EMBEDDINGS_PROVIDER',
  'HINDSIGHT_API_RERANKER_PROVIDER',
  'HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU',
  'HINDSIGHT_API_LOG_LEVEL',
  'HINDSIGHT_EMBED_DAEMON_IDLE_TIMEOUT',
  'HINDSIGHT_EMBED_API_VERSION',
  'HINDSIGHT_API_VERSION',
  'HF_HUB_OFFLINE',
  'TRANSFORMERS_OFFLINE',
  'HF_HUB_DISABLE_TELEMETRY',
] as const
const HINDSIGHT_PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
] as const

class HindsightStartFailure extends Error {
  constructor(
    readonly code: HindsightStartErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HindsightStartFailure'
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

/** Redact common assignment, JSON, URL, and authorization credential forms. */
export function redactSecrets(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[redacted]')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/giu, '$1[redacted]')
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/giu, '$1[redacted]:[redacted]@')
    .replace(/(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)["']\s*:\s*["'])[^"']*(["'])/giu, '$1[redacted]$2')
    .replace(/((?:(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|GITHUB_TOKEN|NPM_TOKEN|HINDSIGHT_[A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET))\s*[:=]\s*["']?))[^\s,;"'}]+/giu, '$1[redacted]')
}

/** Read only a bounded byte tail so a large log cannot block or consume memory. */
function diagnosticTail(profile: string): string | null {
  const safeProfile = profile.replace(/[^A-Za-z0-9._-]/gu, '_')
  const path = join(homedir(), '.hindsight', 'profiles', `${safeProfile}.log`)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const offset = Math.max(0, size - LOG_READ_MAX_BYTES)
    const buffer = Buffer.allocUnsafe(Math.min(LOG_READ_MAX_BYTES, Math.max(1, size)))
    let position = 0
    do {
      const read = readSync(fd, buffer, position, buffer.length - position, offset + position)
      position += read
      if (read === 0) break
    } while (position < buffer.length)

    let content = buffer.subarray(0, position).toString('utf8')
    // A bounded read may start in the middle of a credential-bearing line. Drop
    // that partial line so its key prefix cannot be separated from its value.
    if (offset > 0) {
      const firstBreak = content.indexOf('\n')
      content = firstBreak < 0 ? '' : content.slice(firstBreak + 1)
    }
    const sanitized = redactSecrets(stripAnsi(content))
    const lines = sanitized.split(/\r?\n/u).filter(line => line.trim() !== '')
    const relevant = lines.filter(line => /error|failed|invalid|warning|exception|traceback|timeout/iu.test(line))
    const tail = (relevant.length > 0 ? relevant : lines).slice(-LOG_TAIL_MAX_LINES).join('\n').slice(-LOG_TAIL_MAX_CHARS)
    return tail === '' ? null : tail
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best effort after a read failure */ }
    }
  }
}

function withDiagnostic(message: string, profile: string): string {
  const log = diagnosticTail(profile)
  return log === null ? message : `${message}\n${log}`
}

function failureMessage(error: unknown, profile: string): HindsightStartFailure {
  const cause = error instanceof Error ? error : new Error(String(error))
  if (error instanceof HindsightStartFailure) {
    return error.message.includes('\n')
      ? error
      : new HindsightStartFailure(error.code, withDiagnostic(error.message, profile))
  }
  const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
  if (code === 'ENOENT') return new HindsightStartFailure('executable-missing', withDiagnostic('Hindsight executable was not found; install hindsight-embed', profile))
  if (code === 'EACCES') return new HindsightStartFailure('spawn-failed', withDiagnostic('Permission was denied while starting Hindsight', profile))
  const detail = redactSecrets(stripAnsi(cause.message)).slice(0, 600) || 'unknown launcher error'
  return new HindsightStartFailure('spawn-failed', withDiagnostic(`Hindsight could not start: ${detail}`, profile))
}

/** Resolve a trusted executable without invoking a shell or parsing user argv. */
export function resolveCommand(command: string): string {
  const trimmed = command.trim()
  if (trimmed === '') throw new HindsightStartFailure('executable-missing', 'Hindsight executable is not configured')
  if (/["']/u.test(trimmed)) throw new HindsightStartFailure('spawn-failed', 'Hindsight executable must not contain shell quotes')
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(trimmed)) {
    throw new HindsightStartFailure('spawn-failed', 'Windows script shims are not supported; configure hindsight-embed.exe')
  }
  if (isAbsolute(trimmed) || /[\\/]/u.test(trimmed)) return trimmed
  if (process.platform === 'win32' && /^(?:hindsight-embed(?:\.exe)?)$/iu.test(trimmed)) {
    const local = join(process.env.USERPROFILE ?? homedir(), '.local', 'bin', 'hindsight-embed.exe')
    if (existsSync(local)) return local
  }
  return trimmed
}

function childEnvironment(): Record<string, string> {
  const env = scrubbedParentEnv()
  // Hindsight's Python launcher reads UTF-8 config files with the process code
  // page on some Windows installations unless UTF-8 mode is explicit.
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  for (const name of HINDSIGHT_ENV_KEYS) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  // Provider keys are deliberately forwarded only to the Hindsight child; the
  // normal subprocess scrub prevents them from reaching unrelated children.
  for (const name of HINDSIGHT_PROVIDER_KEYS) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

interface SharedStart {
  promise: Promise<void>
}

const sharedStarts = new Map<string, SharedStart>()

function sharedStartKey(config: HindsightLifecycleConfig): string {
  return [
    config.hindsightUrl,
    config.hindsightProfile,
    config.hindsightCommand,
    config.hindsightStartTimeoutMs,
    config.knowledgeTimeoutMs,
  ].join('\u0000')
}

function timeoutSignal(deadline: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, deadline - Date.now()))
}

async function releaseResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A consumed, locked, or already-aborted body is already released enough
    // for this best-effort cleanup path.
  }
}

async function probeHealthy(config: HindsightLifecycleConfig, signal?: AbortSignal): Promise<boolean> {
  let url: URL
  try {
    const base = config.hindsightUrl.endsWith('/') ? config.hindsightUrl : `${config.hindsightUrl}/`
    url = new URL('health', base)
    const timeout = AbortSignal.timeout(config.knowledgeTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const response = await fetch(url, { signal: combined })
    try {
      return response.ok
    } finally {
      await releaseResponseBody(response)
    }
  } catch {
    // Health is a probe, not a user-visible transport error. The start path
    // turns a deadline or launcher failure into a structured diagnostic, while
    // a status read simply reports offline.
    return false
  }
}

function offlineState(): HindsightLifecycleSnapshot {
  return { status: 'offline', errorCode: null, message: null, startedAt: null }
}

async function runSharedStart(config: HindsightLifecycleConfig): Promise<void> {
  const deadline = Date.now() + config.hindsightStartTimeoutMs
  if (await probeHealthy(config, timeoutSignal(deadline))) return
  if (Date.now() >= deadline) {
    throw new HindsightStartFailure('timeout', withDiagnostic(`Hindsight did not become healthy within ${String(config.hindsightStartTimeoutMs)} ms`, config.hindsightProfile))
  }

  let child: ChildProcess
  try {
    child = spawn(resolveCommand(config.hindsightCommand), [
      '-p', config.hindsightProfile,
      'daemon', 'start',
    ], {
      detached: true,
      env: childEnvironment(),
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (error) {
    throw failureMessage(error, config.hindsightProfile)
  }
  child.unref()
  await waitForHealth(config, child, deadline)
}

function getSharedStart(config: HindsightLifecycleConfig): SharedStart {
  const key = sharedStartKey(config)
  const existing = sharedStarts.get(key)
  if (existing !== undefined) return existing
  const operation = runSharedStart(config)
  const promise = operation.finally(() => {
    if (sharedStarts.get(key)?.promise === promise) sharedStarts.delete(key)
  })
  const shared = { promise }
  sharedStarts.set(key, shared)
  // The shared operation is observed by each controller, but this observer also
  // prevents an unhandled rejection if every controller is disposed mid-start.
  void promise.catch(() => {})
  return shared
}

/**
 * Owns one shared, idempotent start operation for a local Hindsight daemon.
 * The daemon is intentionally detached and shared across Web sessions; dispose
 * only prevents this controller from receiving further state updates.
 */
export class HindsightLifecycle {
  #config: HindsightLifecycleConfig
  #state: HindsightLifecycleSnapshot = { status: 'offline', errorCode: null, message: null, startedAt: null }
  #startPromise: Promise<void> | undefined
  #disposed = false
  #generation = 0
  #lifecycleRevision = 0
  #statusRequestId = 0

  constructor(config: HindsightLifecycleConfig) {
    this.#config = config
  }

  /** Probe `/health` without starting or otherwise mutating Hindsight. */
  async isHealthy(): Promise<boolean> {
    if (this.#disposed) return false
    return probeHealthy(this.#config)
  }

  /** Return the current state, reconciling an externally started daemon. */
  async status(): Promise<HindsightLifecycleSnapshot> {
    const generation = this.#generation
    const requestId = ++this.#statusRequestId
    const revision = this.#lifecycleRevision
    if (this.#disposed) return this.snapshot()
    const healthy = await this.isHealthy()
    if (this.#disposed || generation !== this.#generation) return this.snapshot()
    // A status probe is observational. It may only write the result if no
    // explicit lifecycle transition (start/failure/online) happened while the
    // probe was in flight, and only the newest probe may reconcile the state.
    if (requestId !== this.#statusRequestId || revision !== this.#lifecycleRevision) return this.snapshot()
    // Status probes are observations, not lifecycle transitions. Do not advance
    // the lifecycle revision here: a newer status request must still be able to
    // reconcile if an older probe happened to finish first.
    if (healthy) this.#observeOnline()
    else if (this.#startPromise === undefined && this.#state.status !== 'error') this.#setState(offlineState())
    return this.snapshot()
  }

  /** Accept a manual start request. The returned state is immediate. */
  requestStart(): HindsightLifecycleSnapshot {
    if (this.#disposed || this.#startPromise !== undefined) return this.snapshot()
    const generation = this.#generation
    this.#statusRequestId++
    this.#transition({ status: 'starting', errorCode: null, message: null, startedAt: null })
    const shared = getSharedStart(this.#config)
    const operation = shared.promise.then(
      () => {
        if (!this.#disposed && generation === this.#generation) this.#markOnline()
      },
      (error: unknown) => {
        if (!this.#disposed && generation === this.#generation) this.#transition(recordHindsightFailure(error, this.#config.hindsightProfile))
      },
    )
    this.#startPromise = operation.finally(() => {
      if (!this.#disposed && generation === this.#generation) this.#startPromise = undefined
    })
    void this.#startPromise.catch(() => {})
    return this.snapshot()
  }

  /** Stop lifecycle updates without terminating a shared daemon startup. */
  dispose(): void {
    this.#disposed = true
    this.#generation += 1
    this.#startPromise = undefined
  }

  /** Return a defensive JSON-safe copy for route serialization. */
  snapshot(): HindsightLifecycleSnapshot {
    return { ...this.#state }
  }

  #setState(next: HindsightLifecycleSnapshot): void {
    this.#state = next
  }

  #transition(next: HindsightLifecycleSnapshot): void {
    this.#lifecycleRevision++
    this.#setState(next)
  }

  #observeOnline(): void {
    this.#setState({
      status: 'online',
      errorCode: null,
      message: null,
      startedAt: this.#state.startedAt ?? new Date().toISOString(),
    })
  }

  #markOnline(): void {
    this.#transition({
      status: 'online',
      errorCode: null,
      message: null,
      startedAt: this.#state.startedAt ?? new Date().toISOString(),
    })
  }
}

async function waitForHealth(config: HindsightLifecycleConfig, child: ChildProcess, deadline: number): Promise<void> {
  let childClosed = false
  let childFailure: HindsightStartFailure | undefined
  let resolveClose: (() => void) | undefined
  const close = new Promise<void>(resolve => { resolveClose = resolve })
  const onError = (error: Error): void => {
    // Keep this listener installed until close so a late spawn error can never
    // become an unhandled ChildProcess error after polling has settled.
    childFailure = failureMessage(error, config.hindsightProfile)
    resolveClose?.()
  }
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    childClosed = true
    if (childFailure === undefined && ((code !== null && code !== 0) || signal !== null)) {
      const reason = signal === null
        ? `Hindsight startup process exited with code ${String(code)}`
        : `Hindsight startup process exited after ${signal}`
      childFailure = failureMessage(new HindsightStartFailure('process-failed', reason), config.hindsightProfile)
    }
    resolveClose?.()
  }
  // `error` may be emitted more than once before a detached launcher closes;
  // keep a normal listener until close so late events cannot crash the Host.
  child.on('error', onError)
  child.once('close', onClose)

  const terminate = (): void => {
    if (childClosed || child.exitCode !== null || child.signalCode !== null) return
    try { child.kill() } catch { /* best effort; detached child may already have exited */ }
  }
  const sleep = (duration: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, duration) })
  let healthy = false
  try {
    while (true) {
      if (childFailure !== undefined) throw childFailure
      const remainingBeforeProbe = deadline - Date.now()
      if (remainingBeforeProbe <= 0) {
        throw new HindsightStartFailure('timeout', withDiagnostic(`Hindsight did not become healthy within ${String(config.hindsightStartTimeoutMs)} ms`, config.hindsightProfile))
      }
      if (await probeHealthy(config, timeoutSignal(deadline))) {
        healthy = true
        return
      }
      if (childFailure !== undefined) throw childFailure
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new HindsightStartFailure('timeout', withDiagnostic(`Hindsight did not become healthy within ${String(config.hindsightStartTimeoutMs)} ms`, config.hindsightProfile))
      }
      const wait = sleep(Math.min(POLL_INTERVAL_MS, remaining))
      if (childClosed) {
        // A zero-exit launcher may have handed the daemon off to another process;
        // continue probing until the configured deadline instead of failing early.
        await wait
      } else {
        await Promise.race([wait, close])
      }
    }
  } finally {
    child.off('close', onClose)
    if (childClosed) {
      child.off('error', onError)
    } else {
      // Keep a harmless error listener until the asynchronous child close event.
      child.once('close', () => { child.off('error', onError) })
      if (!healthy) terminate()
    }
  }
}

/** Convert an internal start failure into a route-visible state. */
export function recordHindsightFailure(error: unknown, profile: string): HindsightLifecycleSnapshot {
  const failure = failureMessage(error, profile)
  return { status: 'error', errorCode: failure.code, message: failure.message, startedAt: null }
}

export const internals = { redactSecrets, resolveCommand }
