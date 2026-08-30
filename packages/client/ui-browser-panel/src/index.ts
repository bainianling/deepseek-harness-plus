/**
 * Host half of the browser panel plugin: a loopback-only RPC bridge between
 * the `browser` service (provided by @anweat/dsh-browser) and the GUI panel.
 *
 * Endpoints on the `/dsh-browser-panel` channel:
 * - `status`  — browser availability + active page URL.
 * - `capture` — screenshot the active page via `browser.read()`.
 * - `open`    — navigate the shared browser, with official DSH session bootstrap.
 * - `image`   — read one screenshot file as a data URL (path-confined).
 * - `history` — most recent screenshot files in the snapshot directory.
 *
 * The file-serving endpoint never reads arbitrary paths: a path must either
 * sit inside the dsh-browser snapshot directory or have been vouched for by
 * the browser service itself (a path this plugin previously returned).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-client-ui-browser-panel'

/** RPC channel shared with the client half (src/client/index.tsx). */
export const CHANNEL = '/dsh-browser-panel'

/** Refuse to serve image files above this size. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** History never returns more entries than this. */
const MAX_HISTORY = 50

/** Image extensions the `image` endpoint will encode. */
const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** The slice of dsh-browser's BrowserService this bridge consumes. */
interface BrowserPageState {
  readonly url: string
  readonly title: string
  readonly screenshotPath?: string
}

interface BrowserOpenOptions {
  readonly waitMs?: number
  readonly authProfile?: string
  readonly rulePack?: string
}

type BrowserOpen = (url: string, opts?: BrowserOpenOptions) => Promise<BrowserPageState>

interface BrowserServiceFace {
  read(): Promise<BrowserPageState>
  open: BrowserOpen
  status(): Promise<{ enabled: boolean; headless: boolean; activeUrl?: string }>
}

/** Structural face of the host connection service (typed via cast, no package edge). */
interface HostConnectionFace {
  authenticatedUrl(baseUrl: string): string
  rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown) => Promise<unknown>,
      opts?: { authority?: string },
    ): () => void
  }
}

interface WebServerFace {
  readonly port: number
}

/** Whether a normalized URL hostname is one of the local loopback forms. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

/** Only the active DSH Web origin may receive a browser-session bootstrap URL. */
function isHarnessWebUrl(target: URL, port: number): boolean {
  return target.protocol === 'http:'
    && isLoopbackHostname(target.hostname)
    && target.port === String(port)
}

/**
 * Establish the official signed browser session before visiting an internal DSH URL.
 * The launch token remains host-side; the returned state always comes from the clean
 * target URL after the server has exchanged it for an HttpOnly cookie.
 */
async function openWithHarnessAuth(
  open: BrowserOpen,
  connection: HostConnectionFace,
  target: URL,
  webPort: number | undefined,
  opts?: BrowserOpenOptions,
  removeTransientScreenshot?: (filePath: string) => void,
): Promise<BrowserPageState> {
  const navigate = (url: string): Promise<BrowserPageState> =>
    opts === undefined ? open(url) : open(url, opts)
  if (webPort !== undefined && isHarnessWebUrl(target, webPort)) {
    const bootstrap = await navigate(connection.authenticatedUrl(target.origin))
    if (bootstrap.screenshotPath !== undefined) {
      removeTransientScreenshot?.(bootstrap.screenshotPath)
    }
  }
  return navigate(target.href)
}

export const internals = {
  isHarnessWebUrl,
  openWithHarnessAuth,
}

/** Compute dsh-browser's default snapshot directory (its config.js mirrors this). */
function defaultSnapshotDir(): string {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'data', 'browser', 'snapshots')
}

/** Validate the RPC request payload shape. */
function record(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('request payload must be an object')
  }
  if (JSON.stringify(payload).length > 100_000) {
    throw new Error('request payload exceeds 100000 characters')
  }
  return payload as Record<string, unknown>
}

/** Read and validate a string payload field. */
function stringField(payload: Record<string, unknown>, fieldName: string): string {
  const value = payload[fieldName]
  if (typeof value !== 'string' || value.length < 1 || value.length > 2000) {
    throw new Error(`${fieldName} must be a non-empty string`)
  }
  return value
}

/** Accept only navigable http(s) URLs for the `open` endpoint. */
function httpUrlField(payload: Record<string, unknown>, fieldName: string): URL {
  const raw = stringField(payload, fieldName)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${fieldName} is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${fieldName} must be an http(s) URL`)
  }
  return parsed
}

/**
 * Host plugin body: register the loopback RPC when the connection service is up.
 * The `browser` service is read lazily per call so this plugin never depends on
 * dsh-browser being installed — endpoints degrade to `available: false` instead.
 * @param ctx - Host cordis context.
 */
export function apply(ctx: Context): void {
  /** Paths vouched for by the browser service or a prior history listing. */
  const vouchedPaths = new Set<string>()
  const snapshotRoot = defaultSnapshotDir()

  const getBrowser = (): BrowserServiceFace | undefined => {
    try {
      return ctx.get('browser') as BrowserServiceFace | undefined
    } catch {
      return undefined
    }
  }

  /** Whether a resolved path is safe to serve. */
  const isAllowedPath = (resolved: string): boolean => {
    if (vouchedPaths.has(resolved)) return true
    let root: string
    try {
      root = fs.realpathSync(snapshotRoot)
    } catch {
      // Snapshot directory missing yet: compare against the unresolved root.
      root = snapshotRoot
    }
    const relative = path.relative(root, resolved)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  /** Serve one image file as a data URL after confinement checks. */
  const serveImage = (rawPath: string): { dataUrl: string } => {
    const resolved = path.resolve(rawPath)
    const mime = IMAGE_EXTENSIONS.get(path.extname(resolved).toLowerCase())
    if (mime === undefined) throw new Error('unsupported image type')
    if (!isAllowedPath(resolved)) throw new Error('path is outside the browser snapshot store')
    const stats = fs.statSync(resolved)
    if (!stats.isFile()) throw new Error('not a file')
    if (stats.size > MAX_IMAGE_BYTES) throw new Error('image exceeds the size limit')
    const dataUrl = `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`
    return { dataUrl }
  }

  /** Delete only the authentication handoff screenshot inside the snapshot store. */
  const removeTransientScreenshot = (rawPath: string): void => {
    const resolved = path.resolve(rawPath)
    const relative = path.relative(path.resolve(snapshotRoot), resolved)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return
    try {
      fs.rmSync(resolved, { force: true })
    } catch {
      // Cleanup is best-effort; authentication already completed through HttpOnly cookie exchange.
    }
  }

  /** List the newest screenshot files in the snapshot directory. */
  const listHistory = (limit: number): { path: string; mtime: number; size: number }[] => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(snapshotRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const rows: { path: string; mtime: number; size: number }[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (IMAGE_EXTENSIONS.get(path.extname(entry.name).toLowerCase()) === undefined) continue
      const full = path.join(snapshotRoot, entry.name)
      try {
        const stats = fs.statSync(full)
        vouchedPaths.add(full)
        rows.push({ path: full, mtime: stats.mtimeMs, size: stats.size })
      } catch {
        // A file removed between readdir and stat is simply skipped.
      }
    }
    rows.sort((left, right) => right.mtime - left.mtime)
    return rows.slice(0, Math.min(limit, MAX_HISTORY))
  }

  ctx.inject(['connection'], (connectionCtx) => {
    const connection = (connectionCtx as unknown as { connection: HostConnectionFace }).connection

    // Patch the shared BrowserService once for this plugin fiber so direct AI
    // browser_open calls and GUI panel navigation receive the same DSH session.
    connectionCtx.inject(['browser'], (browserCtx) => {
      const browser = browserCtx.get('browser') as BrowserServiceFace | undefined
      const webServer = browserCtx.get('webServer') as WebServerFace | undefined
      if (browser === undefined || webServer === undefined) return
      const originalOpen = browser.open.bind(browser)
      browser.open = async (rawUrl, opts) => {
        const target = new URL(rawUrl)
        return openWithHarnessAuth(
          originalOpen,
          connection,
          target,
          webServer.port,
          opts,
          removeTransientScreenshot,
        )
      }
      browserCtx.effect(() => () => { browser.open = originalOpen }, 'ui-browser-panel: authenticated browser navigation')
    })

    const dispose = connection.rpc.handle(CHANNEL, async (endpoint, rawPayload) => {
      try {
        const payload = record(rawPayload)
        let value: unknown
        switch (endpoint) {
          case 'status': {
            const browser = getBrowser()
            if (browser === undefined) {
              value = { available: false }
              break
            }
            const status = await browser.status()
            value = { available: true, activeUrl: status.activeUrl, headless: status.headless }
            break
          }
          case 'capture': {
            const browser = getBrowser()
            if (browser === undefined) throw new Error('browser service is unavailable')
            const state = await browser.read()
            if (state.screenshotPath !== undefined) vouchedPaths.add(path.resolve(state.screenshotPath))
            value = { url: state.url, title: state.title, screenshotPath: state.screenshotPath ?? null }
            break
          }
          case 'open': {
            const browser = getBrowser()
            if (browser === undefined) throw new Error('browser service is unavailable')
            const target = httpUrlField(payload, 'url')
            const state = await browser.open(target.href)
            if (state.screenshotPath !== undefined) vouchedPaths.add(path.resolve(state.screenshotPath))
            value = { url: state.url, title: state.title, screenshotPath: state.screenshotPath ?? null }
            break
          }
          case 'image': {
            value = serveImage(stringField(payload, 'path'))
            break
          }
          case 'history': {
            const rawLimit = payload.limit
            const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.floor(rawLimit) : 20
            value = listHistory(limit)
            break
          }
          default:
            return { ok: false, error: { code: 'not-found', message: `unknown browser panel endpoint: ${endpoint}` } }
        }
        return { ok: true, value }
      } catch (error) {
        return {
          ok: false,
          error: { code: 'bad-request', message: String(error instanceof Error ? error.message : error).slice(0, 500) },
        }
      }
    }, { authority: 'loopback' })
    connectionCtx.effect(() => dispose, 'ui-browser-panel: snapshot bridge RPC')
  })
}
