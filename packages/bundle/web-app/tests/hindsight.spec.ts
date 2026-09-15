/** Manual Hindsight lifecycle: adoption, shared starts, failures, and cleanup. */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { HindsightLifecycle, redactSecrets, resolveCommand } from '../src/hindsight.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

const baseConfig = {
  hindsightUrl: 'http://127.0.0.1:19077',
  hindsightProfile: 'test-profile',
  hindsightCommand: 'hindsight-embed',
  hindsightStartTimeoutMs: 30_000,
  knowledgeTimeoutMs: 50,
}

interface FakeChild extends EventEmitter {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function child(): FakeChild {
  const process = new EventEmitter() as FakeChild
  process.exitCode = null
  process.signalCode = null
  process.kill = vi.fn(() => {
    process.signalCode = 'SIGTERM'
    process.emit('close', null, 'SIGTERM')
    return true
  })
  process.unref = vi.fn()
  return process
}

function response(ok: boolean, cancel?: ReturnType<typeof vi.fn>): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    statusText: ok ? 'OK' : 'Service Unavailable',
    body: cancel === undefined ? null : { cancel },
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(spawn).mockReset()
  vi.unstubAllEnvs()
})

describe('HindsightLifecycle', () => {
  it('adopts an already healthy daemon without spawning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(true)))
    const lifecycle = new HindsightLifecycle(baseConfig)

    expect(lifecycle.requestStart().status).toBe('starting')
    await vi.waitFor(() => { expect(lifecycle.snapshot().status).toBe('online') })

    expect(spawn).not.toHaveBeenCalled()
    lifecycle.dispose()
  })

  it('does not let an older offline status probe overwrite a completed start', async () => {
    let releaseStatus!: (value: Response) => void
    const statusProbe = new Promise<Response>(resolve => { releaseStatus = resolve })
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(statusProbe)
      .mockResolvedValueOnce(response(true)))
    const lifecycle = new HindsightLifecycle({ ...baseConfig, hindsightUrl: 'http://127.0.0.1:19081' })

    const statusPromise = lifecycle.status()
    expect(lifecycle.requestStart().status).toBe('starting')
    await vi.waitFor(() => { expect(lifecycle.snapshot().status).toBe('online') })

    releaseStatus(response(false))
    await statusPromise
    expect(lifecycle.snapshot().status).toBe('online')
    lifecycle.dispose()
  })

  it('uses the newest status probe when concurrent probes finish out of order', async () => {
    let releaseFirst!: (value: Response) => void
    let releaseSecond!: (value: Response) => void
    const first = new Promise<Response>(resolve => { releaseFirst = resolve })
    const second = new Promise<Response>(resolve => { releaseSecond = resolve })
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second))
    const lifecycle = new HindsightLifecycle({ ...baseConfig, hindsightUrl: 'http://127.0.0.1:19083' })

    const firstStatus = lifecycle.status()
    const secondStatus = lifecycle.status()
    releaseSecond(response(true))
    await secondStatus
    expect(lifecycle.snapshot().status).toBe('online')
    releaseFirst(response(false))
    await firstStatus
    expect(lifecycle.snapshot().status).toBe('online')
    lifecycle.dispose()
  })

  it('starts the fixed command and waits until the health endpoint is online', async () => {
    const process = child()
    vi.mocked(spawn).mockReturnValue(process as never)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(false))
      .mockResolvedValue(response(true))
    vi.stubGlobal('fetch', fetchMock)
    const lifecycle = new HindsightLifecycle(baseConfig)

    expect(lifecycle.requestStart().status).toBe('starting')
    await vi.waitFor(() => { expect(lifecycle.snapshot().status).toBe('online') })

    expect(spawn).toHaveBeenCalledWith(resolveCommand('hindsight-embed'), ['-p', 'test-profile', 'daemon', 'start'], expect.objectContaining({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: expect.objectContaining({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
    }))
    expect(process.unref).toHaveBeenCalledOnce()
    expect(process.listenerCount('error')).toBe(1)
    process.emit('close', 0, null)
    expect(process.listenerCount('error')).toBe(0)
    lifecycle.dispose()
  })

  it('shares one process-level start operation across controllers', async () => {
    const process = child()
    vi.mocked(spawn).mockReturnValue(process as never)
    let releaseInitial!: (value: Response) => void
    const initial = new Promise<Response>(resolve => { releaseInitial = resolve })
    const fetchMock = vi.fn()
      .mockReturnValueOnce(initial)
      .mockResolvedValue(response(true))
    vi.stubGlobal('fetch', fetchMock)
    const first = new HindsightLifecycle(baseConfig)
    const second = new HindsightLifecycle(baseConfig)

    first.requestStart()
    second.requestStart()
    expect(spawn).not.toHaveBeenCalled()
    releaseInitial(response(false))
    await vi.waitFor(() => { expect(first.snapshot().status).toBe('online') })
    await vi.waitFor(() => { expect(second.snapshot().status).toBe('online') })

    expect(spawn).toHaveBeenCalledOnce()
    first.dispose()
    second.dispose()
  })

  it('releases health response bodies for both healthy and offline probes', async () => {
    const healthyCancel = vi.fn(async () => {})
    const offlineCancel = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(true, healthyCancel))
      .mockResolvedValueOnce(response(false, offlineCancel)))
    const lifecycle = new HindsightLifecycle({ ...baseConfig, hindsightUrl: 'http://127.0.0.1:19082' })

    expect(await lifecycle.isHealthy()).toBe(true)
    expect(await lifecycle.isHealthy()).toBe(false)
    expect(healthyCancel).toHaveBeenCalledOnce()
    expect(offlineCancel).toHaveBeenCalledOnce()
    lifecycle.dispose()
  })

  it('reports a missing executable and keeps the failure actionable', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const error = Object.assign(new Error('spawn hindsight-embed ENOENT'), { code: 'ENOENT' })
      throw error
    })
    vi.stubGlobal('fetch', vi.fn(async () => response(false)))
    const lifecycle = new HindsightLifecycle({ ...baseConfig, hindsightUrl: 'http://127.0.0.1:19078' })

    lifecycle.requestStart()
    await vi.waitFor(() => { expect(lifecycle.snapshot().status).toBe('error') })
    expect(lifecycle.snapshot()).toMatchObject({ status: 'error', errorCode: 'executable-missing' })
    lifecycle.dispose()
  })

  it('times out and terminates a launcher that never becomes healthy', async () => {
    const process = child()
    vi.mocked(spawn).mockReturnValue(process as never)
    vi.stubGlobal('fetch', vi.fn(async () => response(false)))
    const lifecycle = new HindsightLifecycle({
      ...baseConfig,
      hindsightUrl: 'http://127.0.0.1:19079',
      hindsightStartTimeoutMs: 25,
    })

    lifecycle.requestStart()
    await vi.waitFor(() => { expect(lifecycle.snapshot().status).toBe('error') }, { timeout: 1_000 })
    expect(lifecycle.snapshot().errorCode).toBe('timeout')
    expect(process.kill).toHaveBeenCalledOnce()
    lifecycle.dispose()
  })

  it('turns an asynchronous launcher error into a structured failure and cleans listeners', async () => {
    const process = child()
    vi.mocked(spawn).mockReturnValue(process as never)
    vi.stubGlobal('fetch', vi.fn(async () => response(false)))
    const lifecycle = new HindsightLifecycle({ ...baseConfig, hindsightUrl: 'http://127.0.0.1:19084' })

    lifecycle.requestStart()
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledOnce() })
    process.emit('error', Object.assign(new Error('spawn denied'), { code: 'EACCES' }))
    await vi.waitFor(() => { expect(lifecycle.snapshot().status).toBe('error') })

    expect(lifecycle.snapshot()).toMatchObject({ status: 'error', errorCode: 'spawn-failed' })
    expect(process.kill).toHaveBeenCalledOnce()
    expect(process.listenerCount('error')).toBe(0)
    lifecycle.dispose()
  })

  it('does not update a disposed controller after a shared start settles', async () => {
    const process = child()
    vi.mocked(spawn).mockReturnValue(process as never)
    let releaseInitial!: (value: Response) => void
    const initial = new Promise<Response>(resolve => { releaseInitial = resolve })
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(initial)
      .mockResolvedValue(response(true)))
    const lifecycle = new HindsightLifecycle({ ...baseConfig, hindsightUrl: 'http://127.0.0.1:19080' })

    lifecycle.requestStart()
    lifecycle.dispose()
    releaseInitial(response(false))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(lifecycle.snapshot().status).toBe('starting')
    expect(spawn).toHaveBeenCalledOnce()
    process.emit('close', 0, null)
  })
})

describe('Hindsight diagnostics', () => {
  it('redacts bearer/basic credentials, URL credentials, and secret-shaped fields', () => {
    const value = redactSecrets([
      'Authorization: Bearer abc.def.ghi',
      'Authorization: Basic YWJjZA==',
      'https://alice:password@example.test/health',
      'api_key="top-secret" token=abc123 AWS_SECRET_ACCESS_KEY=aws-secret',
    ].join('\n'))

    expect(value).not.toContain('abc.def.ghi')
    expect(value).not.toContain('YWJjZA==')
    expect(value).not.toContain('alice:password')
    expect(value).not.toContain('top-secret')
    expect(value).not.toContain('aws-secret')
    expect(value).toContain('[redacted]')
  })

  it('rejects shell-quoted executable configuration', () => {
    expect(() => resolveCommand('"hindsight-embed"')).toThrow(/shell quotes/u)
    expect(() => resolveCommand('')).toThrow(/not configured/u)
  })
})
