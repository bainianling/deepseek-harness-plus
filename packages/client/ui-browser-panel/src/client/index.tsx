/**
 * Client half of the browser panel plugin: mounts the panel + toggle button
 * into a dedicated DOM container and builds the host bridge over the
 * `/dsh-browser-panel` loopback RPC (served by this package's host half, which
 * talks to the `browser` service of @anweat/dsh-browser).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  BrowserPanelProvider,
  type BridgeHistoryRow, type BrowserPanelBridge,
} from './BrowserPanelContext.tsx'
import { BrowserPanel } from './BrowserPanel.tsx'
import { BrowserToggleButton } from './BrowserToggleButton.tsx'

export { BrowserPanel } from './BrowserPanel.tsx'
export { BrowserToggleButton } from './BrowserToggleButton.tsx'
export { BrowserPanelProvider, useBrowserPanel } from './BrowserPanelContext.tsx'
export { OPEN_URL_EVENT } from './BrowserPanelContext.tsx'
export type { BrowserPanelBridge, BridgeHistoryRow, OpenUrlEventDetail } from './BrowserPanelContext.tsx'
export type { BrowserScreenshot } from './contract/slots.ts'

/** Plugin name shown on the boot page. */
export const name = 'dsh-client-ui-browser-panel'

/** Services required by the client plugin. */
export const inject = ['connection']

/** RPC channel — must stay in sync with the host half (src/index.ts). */
const CHANNEL = '/dsh-browser-panel'

/** DOM container the panel mounts into (kept across HMR remounts). */
const CONTAINER_ID = 'dsh-browser-panel-root'

/** Successful RPC envelope. */
interface RpcOk<T> { ok: true; value: T }

/** Failed RPC envelope. */
interface RpcErr { ok: false; error: { code: string; message: string } }

type RpcResult<T> = RpcOk<T> | RpcErr

/** Shape of the connection service slice this plugin consumes. */
interface RpcFace {
  call<T>(channel: string, endpoint: string, payload: unknown): Promise<T>
}

/** Connection service handle provided at runtime by dsh-client-connection. */
interface ConnectionFace {
  rpc: RpcFace
}

/**
 * Build the host bridge on top of the connection RPC.
 * @param rpc - client connection RPC face.
 * @returns the bridge consumed by BrowserPanelProvider.
 */
function createBridge(rpc: RpcFace): BrowserPanelBridge {
  async function call<T>(endpoint: string, payload: unknown): Promise<T> {
    const result = await rpc.call<RpcResult<T>>(CHANNEL, endpoint, payload)
    if (result === null || typeof result !== 'object' || !('ok' in result)) {
      throw new Error(`browser panel RPC ${endpoint}: malformed response`)
    }
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  return {
    status: async () => {
      try {
        return await call<{ available: boolean; activeUrl?: string }>('status', {})
      } catch {
        return { available: false }
      }
    },
    capture: async () => {
      try {
        return await call<{ url: string; title: string; screenshotPath: string | null } | null>('capture', {})
      } catch {
        return null
      }
    },
    openUrl: async (url: string) => {
      try {
        return await call<{ url: string; title: string; screenshotPath: string | null }>('open', { url })
      } catch {
        return null
      }
    },
    history: async (limit: number) => {
      try {
        return await call<BridgeHistoryRow[]>('history', { limit })
      } catch {
        return []
      }
    },
    image: async (path: string) => {
      try {
        const value = await call<{ dataUrl: string }>('image', { path })
        return value.dataUrl
      } catch {
        return null
      }
    },
  }
}

/**
 * Mount the browser panel UI and dispose it with the plugin fiber.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionFace
  const bridge = createBridge(connection.rpc)

  ctx.effect(() => {
    let container = document.getElementById(CONTAINER_ID)
    const created = container === null
    if (container === null) {
      container = document.createElement('div')
      container.id = CONTAINER_ID
      document.body.appendChild(container)
    }
    const root: Root = createRoot(container)
    root.render(
      createElement(BrowserPanelProvider, { bridge },
        createElement(BrowserToggleButton),
        createElement(BrowserPanel),
      ),
    )
    return () => {
      root.unmount()
      if (created) container?.remove()
    }
  }, 'ui-browser-panel: mount')
}
