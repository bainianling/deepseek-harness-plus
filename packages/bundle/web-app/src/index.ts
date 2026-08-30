/**
 * @deepseek-ai/dsh-web-app — the browser-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the browser-surface glue: it resolves
 * the built frontend dist (workspace knowledge of this bundle, never user
 * config), mounts the `frontend-static` fallback owner over it, registers the
 * harness-source and web-surface prompt sections, the bash-visible web runtime
 * variable, the process-token URL line, and the default-browser handoff. The
 * model and shell retain the clean URL. App command-line values arrive through
 * the `webStartup` service expressions in the bundle patch.
 * @module @deepseek-ai/dsh-web-app
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-client-connection'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'
import { registerKnowledgeRoutes } from './knowledge.ts'
import { registerMarketRoutes } from './market.ts'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const ANNOUNCED_ROOTS = new WeakSet<Context>()

/** Runtime service that releases Web rows after bind-dependent values resolve. */
const WEB_RUNTIME_SERVICE = 'webRuntime'

/** Services required before the web runtime can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; an SSH launch suppresses it. */
  openBrowser: boolean
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the model-visible surface context (the `app:web-surface` prompt
   * section and the `DSH_WEB_URL` bash variable). A one-shot non-interactive
   * layer can turn it off when its user is not in the GUI, so the
   * orientation text would be false.
   */
  surfaceContext: boolean
  /** Explicit `--trusted-host` authorities from this invocation. */
  trustedHosts: string[]
  /** Local Hindsight API projected into the knowledge center. */
  hindsightUrl: string
  /** Hindsight bank projected into this Web GUI. */
  hindsightBankId: string
  /** Maximum duration of one Hindsight read. */
  knowledgeTimeoutMs: number
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  hindsightUrl: z.string().default('http://127.0.0.1:9077'),
  hindsightBankId: z.string().default('coding-agent::deepseek-harness'),
  knowledgeTimeoutMs: z.number().min(100).max(30_000).default(5_000),
})

/** Bind-dependent Web values shared by the trust fence and LAN sharing control. */
export interface WebRuntimeValues {
  /** LAN IPv4 literals sampled once when the server binds all interfaces. */
  lanAddresses: string[]
  /** Static invocation authorities only; LAN literals require explicit sharing. */
  trustedHosts: string[]
}

/** Mutable access state for explicitly enabled local-network sharing. */
export interface LanShare {
  /** Current enablement and the LAN addresses that can be shared. */
  snapshot(): { enabled: boolean; addresses: readonly string[]; port: number }
  /** Enable or disable access from the displayed LAN IP literals. */
  setEnabled(enabled: boolean): { enabled: boolean; addresses: readonly string[]; port: number }
  /** Current API trust entries: static values plus LAN IP literals while enabled. */
  trustedHosts(): readonly string[]
}

/** Environment variable naming the canonical local URL of this Web GUI. */
const DSH_WEB_URL = 'DSH_WEB_URL' as const

// Display-only mirror of the webserver schema's loopback host: the address the
// local URL always prints. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/** Whether this process was launched through SSH, including a forwarded-port session. */
function launchedThroughSsh(ctx: Context): boolean {
  const environment = launchEnvironmentOf(ctx)
  return ['SSH_CONNECTION', 'SSH_TTY'].some((name) => {
    const value = environment.getFrom(name, ['process'])?.value
    return value !== undefined && value !== ''
  })
}

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const launcher = await open(process.argv[1])
  if (process.platform === 'win32') {
    // open resolves at PowerShell spawn; keep it referenced until that launcher hands the URL to Windows.
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      function onError(error) {
        launcher.off('close', onClose)
        reject(error)
      }
      function onClose(code) {
        launcher.off('error', onError)
        resolve(code)
      }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  // The parent turns this exit into the manual-URL warning.
  console.error(error)
  process.exitCode = 1
}
`

/**
 * Resolve one LAN-trust snapshot from the active server bind.
 *
 * Derived entries are port-less IP literals: DNS rebinding needs an
 * attacker-controlled name, while an IP-literal Host is safe on any port and
 * an OS-assigned port is unknowable before bind.
 * @param bindHost - the active webserver bind host.
 * @param extra - explicit `--trusted-host` values, in argument order.
 * @returns the LAN display addresses and invocation-derived fence authorities.
 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const privateIpv4 = (address: string): boolean => {
    const [firstText = '', secondText = '', thirdText = '', fourthText = '', ...rest] = address.split('.')
    if (rest.length !== 0) return false
    const first = Number(firstText)
    const second = Number(secondText)
    const third = Number(thirdText)
    const fourth = Number(fourthText)
    if (![first, second, third, fourth].every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)) return false
    return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
  }
  const virtualInterface = /^(?:lo|utun|tun|tap|wg|docker|br-|vethernet|radmin|tailscale)/iu
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.entries(networkInterfaces())
      .flatMap(([name, interfaces]) => (interfaces ?? []).map(iface => ({ name, iface })))
      .filter(({ name, iface }) => iface.family === 'IPv4' && !iface.internal && !virtualInterface.test(name))
      .sort((left, right) => Number(privateIpv4(right.iface.address)) - Number(privateIpv4(left.iface.address)))
      .map(({ iface }) => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...extra] }
}

/** Whether a request came through the host's own loopback interface. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
}

/** Read an IPv4 Host header literal, rejecting a port-less or malformed authority. */
function hostAddress(req: IncomingMessage): string | undefined {
  const authority = req.headers.host
  if (authority === undefined) return undefined
  try {
    return new URL(`http://${authority}`).hostname
  } catch {
    return undefined
  }
}

/** Match a request authority against a deployment's explicit trusted-host entries. */
function isExplicitTrustedHost(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const authority = req.headers.host?.toLowerCase()
  const hostname = hostAddress(req)
  return authority !== undefined && hostname !== undefined
    && trustedHosts.some(entry => entry === authority || entry === hostname)
}

/** Browser-only local control requests must stay same-origin with the loopback GUI. */
function isLocalControlRequest(req: IncomingMessage): boolean {
  if (!isLoopbackRequest(req)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** Minimal JSON response for the LAN-share control surface. */
function writeLanShareSnapshot(res: ServerResponse, lanShare: LanShare, canControl: boolean): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ ...lanShare.snapshot(), canControl }))
}

/** Model-visible orientation and acceptance boundary for sessions created through `dsh web`. */
function webSurfacePrompt(webUrl: string): string {
  const updateContract = 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  return `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + updateContract
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
}

/** Resolve the canonical loopback URL from the active Web server. */
function localWebUrl(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('web-app: webServer service missing while resolving Web runtime')
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/**
 * Dist location is workspace knowledge of this bundle: anchored on the
 * frontend package manifest, not configured. Existence is a request-time
 * concern — the fallback owner reads files per request, so a composition
 * whose page never reaches the fallback seat (the static worker preview
 * ships its own page and carries no dist) boots without one.
 */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only when the frontend package is absent from the checkout */
    throw new Error('web-app: @deepseek-ai/dsh-web-frontend is not resolvable from this composition')
  }
}

/** Start the maintained platform opener without forwarding Harness credentials. */
function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/** Hand one URL to the operating system's default browser. */
async function openBrowser(url: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      launcher.off('close', onClose)
      reject(error)
    }
    function onClose(code: number | null): void {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\r?\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/** Test hooks for the built dist and native browser handoff; production never mutates them. */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string) => Promise<void>
} = { resolveDistIndex, openBrowser }

/**
 * Mount the Web runtime: dist serving, surface prompt, the bash runtime
 * variable, the URL line, the default-browser handoff, and the opt-in LAN
 * sharing control surface.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  registerKnowledgeRoutes(ctx, config)
  registerMarketRoutes(ctx)
  let enabled = false
  const lanShare: LanShare = {
    snapshot: () => ({ enabled, addresses: runtime.lanAddresses, port: ctx.webServer.port }),
    setEnabled: (next) => {
      enabled = next && runtime.lanAddresses.length > 0
      return lanShare.snapshot()
    },
    trustedHosts: () => enabled ? [...runtime.trustedHosts, ...runtime.lanAddresses] : runtime.trustedHosts,
  }
  ctx.provide('lanShare', lanShare)
  // The listener remains reachable only by loopback until the local operator
  // explicitly enables sharing; IP literals also prevent DNS-rebinding hosts.
  ctx.effect(() => ctx.webServer.guard((req) => {
    if (isLoopbackRequest(req) || isExplicitTrustedHost(req, runtime.trustedHosts)) return true
    return lanShare.snapshot().enabled && runtime.lanAddresses.includes(hostAddress(req) ?? '')
  }), 'web-app: LAN access guard')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/lan-share',
    handler: (req, res) => {
      if (req.method === 'GET') {
        writeLanShareSnapshot(res, lanShare, isLocalControlRequest(req))
        return
      }
      if (req.method !== 'POST' || !isLocalControlRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.once('end', () => {
        try {
          const value = JSON.parse(body) as { enabled?: unknown }
          if (typeof value.enabled !== 'boolean') throw new Error('invalid body')
          lanShare.setEnabled(value.enabled)
          writeLanShareSnapshot(res, lanShare, true)
        } catch {
          res.writeHead(400)
          res.end('invalid request')
        }
      })
      req.once('error', () => {
        if (!res.headersSent) {
          res.writeHead(400)
          res.end('invalid request')
        }
      })
    },
  }), 'web-app: LAN share control')
  // The GUI's server-stop control: a loopback-only, same-origin POST that
  // requests the launcher's bounded process exit once the ack is flushed.
  // The graceful path disposes the whole application tree (sockets, sessions,
  // plugins) before the process ends — killing the listener directly would
  // skip that teardown.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/server/shutdown',
    handler: (req, res) => {
      if (req.method !== 'POST' || !isLocalControlRequest(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const appExit = ctx.get('appExit') as AppExit | undefined
      if (appExit === undefined) {
        res.writeHead(503)
        res.end('shutdown unavailable')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true }))
      // Flush the ack before teardown starts, so the browser sees success
      // while the disposal (and its connection drops) run behind it.
      setTimeout(() => { appExit(0) }, 150)
    },
  }), 'web-app: server shutdown control')
  // The loopback URL belongs to this host. Under SSH, the operator reaches it
  // through a local forwarding address that this process cannot derive.
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(ctx)
  // Release dependent rows only after bind-dependent trust has been sampled once.
  ctx.provide(WEB_RUNTIME_SERVICE, runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, SOURCE_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: FIRST_PARTY_SECTION_ORDER.WEB_SURFACE,
        text: () => webSurfacePrompt(localWebUrl(promptCtx)),
      })
    })
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Canonical local URL of the DeepSeek Harness Web GUI serving this session.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: localWebUrl(runtimeCtx) }),
      })
    })
  }
  if (config.printUrl || handoffBrowser) {
    ctx.inject(['connection'], (connectionCtx) => {
      // The URL line and browser handoff are readiness signals: supervisors RPC
      // as soon as they observe the line, while a browser requests the page as
      // soon as it opens. Neither may run while sibling rows such as the /api
      // route owner are still mounting. Await Loader settlement first; a
      // hand-built tree without a Loader is already the complete tree.
      const announceReady = (): void => {
        if (ANNOUNCED_ROOTS.has(connectionCtx.root)) return
        const webUrl = localWebUrl(connectionCtx)
        const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl)
        ANNOUNCED_ROOTS.add(connectionCtx.root)
        if (config.printUrl) {
          console.log(`dsh web: ${authenticatedUrl}`)
        }
        if (handoffBrowser) {
          console.log('dsh web: opening the default browser; pass --no-open to disable')
          void internals.openBrowser(authenticatedUrl).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error)
            console.error(`web-app: could not open the default browser because ${reason}; use the dsh web URL printed at startup`)
          })
        }
      }
      // This row's own activation can precede a sibling failure. The app owns
      // readiness by waiting for its Loader tree, or announces at once in a
      // hand-built tree without Loader.
      const settled = connectionCtx.get('loader')?.await()
      if (settled === undefined) announceReady()
      else {
        void settled.then(() => {
          // The tree can be disposed while the boot was in flight (early
          // SIGTERM); a URL line or browser tab for a dead server would only
          // mislead, and reading torn-down services would turn a clean shutdown
          // into a crash.
          if (connectionCtx.get('webServer') !== undefined
            && connectionCtx.get('connection') !== undefined) announceReady()
        // Loader reports a failed boot; this row only stays quiet.
        }, () => {})
      }
    })
  }
}
