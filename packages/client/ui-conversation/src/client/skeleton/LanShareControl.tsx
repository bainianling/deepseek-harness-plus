import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconCopyOutline16, IconRefreshOutline16, IconShareOutline16, Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './LanShareControl.module.css'

type LanShareState = {
  enabled: boolean
  addresses: string[]
  port: number
  canControl: boolean
}

const EMPTY: LanShareState = { enabled: false, addresses: [], port: 0, canControl: false }
const VIEWPORT_KEY = 'dsh.lan-share.viewport'
const DEFAULT_VIEWPORT = { width: '390', height: '844' }

type ShareViewport = typeof DEFAULT_VIEWPORT

function readStoredViewport(): ShareViewport {
  try {
    const value = JSON.parse(localStorage.getItem(VIEWPORT_KEY) ?? '') as Partial<ShareViewport>
    if (typeof value.width === 'string' && typeof value.height === 'string') return value as ShareViewport
  } catch {
    // A malformed local value must not prevent the sharing control from loading.
  }
  return DEFAULT_VIEWPORT
}

function parseViewport(viewport: ShareViewport): { width: number; height: number } | undefined {
  const width = Number(viewport.width)
  const height = Number(viewport.height)
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined
  if (width < 240 || width > 2560 || height < 320 || height > 3840) return undefined
  return { width, height }
}

function readState(value: unknown): LanShareState {
  if (value === null || typeof value !== 'object') return EMPTY
  const data = value as Record<string, unknown>
  const addresses = Array.isArray(data.addresses)
    ? data.addresses.filter((address): address is string => typeof address === 'string')
    : []
  return {
    enabled: data.enabled === true,
    addresses,
    port: typeof data.port === 'number' ? data.port : 0,
    canControl: data.canControl === true,
  }
}

async function requestState(init?: RequestInit): Promise<LanShareState> {
  const response = await fetch('/lan-share', { cache: 'no-store', ...init })
  if (!response.ok) throw new Error(String(response.status))
  return readState(await response.json())
}

/** Local LAN sharing control rendered beside the composer image-import button. */
export function LanShareControl({ buttonClassName }: { buttonClassName: string | undefined }) {
  const [state, setState] = useState<LanShareState>(EMPTY)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewport, setViewport] = useState<ShareViewport>(readStoredViewport)

  const viewportSize = useMemo(() => parseViewport(viewport), [viewport])

  useEffect(() => {
    try {
      localStorage.setItem(VIEWPORT_KEY, JSON.stringify(viewport))
    } catch {
      // Persistence is optional; the active share link still carries the size.
    }
  }, [viewport])

  const refresh = useCallback(() => {
    setBusy(true)
    setError(null)
    void requestState().then(setState).catch(() => {
      setError('无法读取共享状态，请检查本机服务。')
    }).finally(() => { setBusy(false) })
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const url = useMemo(() => {
    const address = state.addresses[0]
    if (address === undefined || state.port <= 0) return undefined
    const target = new URL(`http://${address}:${String(state.port)}`)
    if (viewportSize !== undefined) {
      target.searchParams.set('dsh-viewport', `${String(viewportSize.width)}x${String(viewportSize.height)}`)
    }
    return target.toString()
  }, [state.addresses, state.port, viewportSize])

  const toggle = (): void => {
    if (!state.canControl || busy || state.addresses.length === 0) return
    setBusy(true)
    setError(null)
    void requestState({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !state.enabled }),
    }).then((next) => {
      setState(next)
      setOpen(true)
    }).catch(() => {
      setError('无法更新共享状态，请稍后重试。')
    }).finally(() => { setBusy(false) })
  }

  const copy = (): void => {
    if (url === undefined) return
    void writeClipboard(url).then((didCopy) => {
      setCopied(didCopy)
      if (didCopy) window.setTimeout(() => { setCopied(false) }, 1500)
    })
  }

  const unavailable = state.addresses.length === 0
  const label = state.enabled ? '局域网共享已开启' : '局域网共享'

  return (
    <div className={css.root}>
      <Tooltip label={label} side="top" delayMs={500}>
        <button
          type="button"
          className={state.enabled ? `${buttonClassName} ${css.active}` : buttonClassName}
          aria-label={label}
          aria-expanded={open}
          onClick={() => {
            setOpen(current => !current)
            if (!open) refresh()
          }}
        >
          <IconShareOutline16 size={14} />
        </button>
      </Tooltip>
      {open && (
        <section className={css.panel} aria-label="局域网共享">
          <div className={css.panelHeader}>
            <span>局域网共享</span>
            <div className={css.panelActions}>
              <Tooltip label="刷新状态" side="top" delayMs={350}>
                <button type="button" className={css.refresh} aria-label="刷新状态" disabled={busy} onClick={refresh}>
                  <IconRefreshOutline16 size={14} />
                </button>
              </Tooltip>
              {state.canControl && (
                <label className={css.switch}>
                  <input type="checkbox" checked={state.enabled} disabled={unavailable || busy} onChange={toggle} />
                  <span aria-hidden="true" />
                </label>
              )}
            </div>
          </div>
          {error !== null ? (
            <p className={css.error} role="alert">{error}</p>
          ) : unavailable ? (
            <p className={css.muted}>未检测到可用的局域网 IPv4 地址。</p>
          ) : state.enabled && url !== undefined ? (
            <>
              <div className={css.viewportFields}>
                <label>
                  <span>宽度</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="240"
                    max="2560"
                    value={viewport.width}
                    aria-label="手机布局宽度"
                    onChange={event => { setViewport(current => ({ ...current, width: event.target.value })) }}
                  />
                </label>
                <span className={css.viewportTimes} aria-hidden>×</span>
                <label>
                  <span>高度</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="320"
                    max="3840"
                    value={viewport.height}
                    aria-label="手机布局高度"
                    onChange={event => { setViewport(current => ({ ...current, height: event.target.value })) }}
                  />
                </label>
                <span className={css.viewportUnit}>px</span>
              </div>
              {viewportSize === undefined && <p className={css.error}>请输入 240–2560 × 320–3840 之间的整数分辨率。</p>}
              <div className={css.addressBlock}>
                <span className={css.address}>{url}</span>
                <Tooltip label={copied ? '已复制' : '复制地址'} side="top" delayMs={350}>
                  <button type="button" className={css.copy} aria-label="复制地址" onClick={copy}>
                    <IconCopyOutline16 size={16} />
                  </button>
                </Tooltip>
              </div>
            </>
          ) : state.canControl ? (
            <p className={css.muted}>开启后可在同一局域网的手机浏览器中访问。</p>
          ) : (
            <p className={css.muted}>此设备正在使用本机共享会话。</p>
          )}
        </section>
      )}
    </div>
  )
}
