/**
 * Browser panel context provider. Owns the panel state and — when a host
 * bridge is supplied by the plugin's client entry — synchronizes with the
 * dsh-browser snapshot store: initial history load, a light poll for new
 * screenshots taken by browser tools, and an explicit active-page capture.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'
import type { BrowserScreenshot } from './contract/slots.ts'

/** One row of the host snapshot history listing. */
export interface BridgeHistoryRow {
  /** Absolute screenshot path on the host. */
  path: string
  /** File modification time (ms epoch). */
  mtime: number
  /** File size in bytes. */
  size: number
}

/** Host RPC bridge implemented by the plugin's client entry. */
export interface BrowserPanelBridge {
  /** Browser service availability + active page URL. */
  status: () => Promise<{ available: boolean; activeUrl?: string }>
  /** Screenshot the browser's active page. Null when there is no active page. */
  capture: () => Promise<{ url: string; title: string; screenshotPath: string | null } | null>
  /** Navigate the built-in browser to a URL and screenshot it. Null on failure. */
  openUrl: (url: string) => Promise<{ url: string; title: string; screenshotPath: string | null } | null>
  /** Newest screenshot files in the snapshot directory. */
  history: (limit: number) => Promise<BridgeHistoryRow[]>
  /** Read one screenshot file as a data URL; null when the host refuses. */
  image: (path: string) => Promise<string | null>
}

/** DOM event any GUI surface dispatches to open a URL in the built-in browser. */
export const OPEN_URL_EVENT = 'dsh-browser-panel:open'

/** DOM event asking the panel to become visible without navigating anywhere. */
export const SHOW_PANEL_EVENT = 'dsh-browser-panel:show'

/** Payload carried by {@link OPEN_URL_EVENT}. */
export interface OpenUrlEventDetail {
  /** Absolute http(s) URL to open. */
  url: string
  /** Completion callback lets callers fall back when the RPC fails. */
  onResult?: (opened: boolean) => void
}

/** Browser panel context value. */
export interface BrowserPanelContextValue {
  /** Whether the panel is open. */
  isOpen: boolean
  /** Toggle the panel open/closed. */
  togglePanel: () => void
  /** Open the panel. */
  openPanel: () => void
  /** Close the panel. */
  closePanel: () => void
  /** List of screenshots (newest first). */
  screenshots: BrowserScreenshot[]
  /** Add a new screenshot (optional explicit timestamp, e.g. a file mtime). */
  addScreenshot: (screenshot: Omit<BrowserScreenshot, 'id' | 'timestamp'> & { timestamp?: number }) => void
  /** Remove a screenshot. */
  removeScreenshot: (id: string) => void
  /** Clear all screenshots. */
  clearScreenshots: () => void
  /** Currently selected screenshot ID for fullscreen view. */
  selectedScreenshotId: string | null
  /** Select a screenshot for fullscreen view. */
  selectScreenshot: (id: string | null) => void
  /** Whether a capture is in flight. */
  busy: boolean
  /** Whether the host browser service is reachable. */
  available: boolean
  /** URL of the browser's active page (when any). */
  activeUrl: string | undefined
  /** Capture the browser's active page into the panel. */
  capture: () => Promise<void>
  /** Navigate the built-in browser to a URL and show it in the panel. */
  openUrl: (url: string) => Promise<boolean>
  /** Re-sync the snapshot history from the host. */
  refresh: () => Promise<void>
}

const BrowserPanelContext = createContext<BrowserPanelContextValue | null>(null)

/** Generate a unique ID for screenshots. */
function generateId(): string {
  return `ss-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Maximum number of screenshots to retain. */
const MAX_SCREENSHOTS = 50

/** Poll cadence for new screenshots taken by browser tools. */
const POLL_INTERVAL_MS = 8000

/** Initial history load depth. */
const INITIAL_HISTORY = 12

/** Per-poll fetch budget for brand-new screenshots. */
const POLL_FETCH_BUDGET = 3

/** Skip history files larger than this (keeps the wire light). */
const MAX_PREFETCH_BYTES = 6 * 1024 * 1024

/** Browser panel provider props. */
export interface BrowserPanelProviderProps {
  /** Rendered children; optional in the type because createElement passes them positionally. */
  children?: ReactNode
  /** Optional host bridge; without it the panel stays a manual-only store. */
  bridge?: BrowserPanelBridge
}

/**
 * Browser panel context provider. Wraps the app to provide browser panel state.
 * @param props - provider props with children and the optional host bridge.
 * @returns the provider element.
 */
export function BrowserPanelProvider({ children, bridge }: BrowserPanelProviderProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [screenshots, setScreenshots] = useState<BrowserScreenshot[]>([])
  const [selectedScreenshotId, setSelectedScreenshotId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState(false)
  const [activeUrl, setActiveUrl] = useState<string | undefined>(undefined)

  /** Host paths already represented in the list (dedupe across polls). */
  const knownPaths = useRef(new Set<string>())
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge

  const togglePanel = useCallback(() => {
    setIsOpen(prev => !prev)
  }, [])

  const openPanel = useCallback(() => {
    setIsOpen(true)
  }, [])

  const closePanel = useCallback(() => {
    setIsOpen(false)
  }, [])

  const addScreenshot = useCallback((screenshot: Omit<BrowserScreenshot, 'id' | 'timestamp'> & { timestamp?: number }) => {
    setScreenshots(prev => {
      const { timestamp, ...rest } = screenshot
      const newScreenshot: BrowserScreenshot = {
        ...rest,
        id: generateId(),
        timestamp: timestamp ?? Date.now(),
      }
      const updated = [newScreenshot, ...prev]
      // Enforce max count
      if (updated.length > MAX_SCREENSHOTS) {
        return updated.slice(0, MAX_SCREENSHOTS)
      }
      return updated
    })
  }, [])

  const removeScreenshot = useCallback((id: string) => {
    setScreenshots(prev => prev.filter(s => s.id !== id))
    setSelectedScreenshotId(prev => prev === id ? null : prev)
  }, [])

  const clearScreenshots = useCallback(() => {
    // Known host paths stay known: a cleared list must not refill from the
    // next poll — only genuinely new screenshots reappear.
    setScreenshots([])
    setSelectedScreenshotId(null)
  }, [])

  const selectScreenshot = useCallback((id: string | null) => {
    setSelectedScreenshotId(id)
  }, [])

  /** Sync the status line from the host. */
  const syncStatus = useCallback(async () => {
    const current = bridgeRef.current
    if (current === undefined) return
    try {
      const status = await current.status()
      setAvailable(status.available)
      setActiveUrl(status.activeUrl)
    } catch {
      setAvailable(false)
    }
  }, [])

  /** Add one history row (fetching its image) unless it is already known. */
  const ingestRow = useCallback(async (row: BridgeHistoryRow): Promise<void> => {
    const current = bridgeRef.current
    if (current === undefined) return
    if (knownPaths.current.has(row.path)) return
    if (row.size > MAX_PREFETCH_BYTES) {
      knownPaths.current.add(row.path)
      return
    }
    const dataUrl = await current.image(row.path)
    if (dataUrl === null) return
    knownPaths.current.add(row.path)
    addScreenshot({ url: '', imageData: dataUrl, timestamp: row.mtime })
  }, [addScreenshot])

  /** Full history sync: newest files first, capped fetch budget per call. */
  const syncHistory = useCallback(async (limit: number, budget: number): Promise<void> => {
    const current = bridgeRef.current
    if (current === undefined) return
    let rows: BridgeHistoryRow[]
    try {
      rows = await current.history(limit)
    } catch {
      return
    }
    let fetched = 0
    // Rows arrive newest-first; ingest oldest-first so prepends land newest-on-top.
    for (const row of [...rows].reverse()) {
      if (knownPaths.current.has(row.path)) continue
      if (fetched >= budget) break
      fetched += 1
      try {
        await ingestRow(row)
      } catch {
        // One unreadable file must not abort the rest of the sync.
      }
    }
  }, [ingestRow])

  /** Manual capture of the browser's active page. */
  const capture = useCallback(async () => {
    const current = bridgeRef.current
    if (current === undefined || busy) return
    setBusy(true)
    try {
      const state = await current.capture()
      if (state !== null && state.screenshotPath !== null) {
        const dataUrl = await current.image(state.screenshotPath)
        if (dataUrl !== null) {
          knownPaths.current.add(state.screenshotPath)
          addScreenshot({ url: state.url, imageData: dataUrl, title: state.title })
          setIsOpen(true)
        }
      }
      await syncStatus()
    } catch {
      // Capture failures surface through the status line; keep the panel calm.
    } finally {
      setBusy(false)
    }
  }, [addScreenshot, busy, syncStatus])

  /** Navigate the built-in browser to a URL and surface the result. */
  const openUrl = useCallback(async (url: string): Promise<boolean> => {
    const current = bridgeRef.current
    if (current === undefined || busy) return false
    setBusy(true)
    try {
      const state = await current.openUrl(url)
      if (state === null) return false
      if (state.screenshotPath !== null) {
        const dataUrl = await current.image(state.screenshotPath)
        if (dataUrl !== null) {
          knownPaths.current.add(state.screenshotPath)
          addScreenshot({ url: state.url, imageData: dataUrl, title: state.title })
        }
      }
      setActiveUrl(state.url)
      setIsOpen(true)
      return true
    } catch {
      return false
    } finally {
      setBusy(false)
    }
  }, [addScreenshot, busy])

  /** Manual history re-sync. */
  const refresh = useCallback(async () => {
    await syncStatus()
    await syncHistory(INITIAL_HISTORY, INITIAL_HISTORY)
  }, [syncHistory, syncStatus])

  // Global entry point: any GUI surface dispatches OPEN_URL_EVENT to open a
  // URL in the built-in browser. preventDefault marks the request handled, so
  // the dispatcher can fall back to a normal tab when the panel is absent.
  useEffect(() => {
    if (bridge === undefined) return
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<OpenUrlEventDetail>).detail
      if (detail === undefined || typeof detail.url !== 'string' || detail.url === '') return
      event.preventDefault()
      void openUrl(detail.url).then(opened => { detail.onResult?.(opened) })
    }
    window.addEventListener(OPEN_URL_EVENT, onOpen)
    return () => { window.removeEventListener(OPEN_URL_EVENT, onOpen) }
  }, [bridge, openUrl])

  // Show-only entry point: surfaces that drive the browser through host routes
  // (e.g. the news panel's Douyin login) ask the panel to become visible
  // without replacing the page the host already opened.
  useEffect(() => {
    if (bridge === undefined) return
    const onShow = (event: Event): void => {
      event.preventDefault()
      openPanel()
    }
    window.addEventListener(SHOW_PANEL_EVENT, onShow)
    return () => { window.removeEventListener(SHOW_PANEL_EVENT, onShow) }
  }, [bridge, openPanel])

  // Boot sync + steady-state poll. The poll only lists the directory; images
  // transfer for brand-new files within a small per-cycle budget.
  useEffect(() => {
    if (bridge === undefined) return
    void syncStatus()
    void syncHistory(INITIAL_HISTORY, INITIAL_HISTORY)
    const timer = window.setInterval(() => {
      void syncStatus()
      void syncHistory(20, POLL_FETCH_BUDGET)
    }, POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [bridge, syncHistory, syncStatus])

  const value: BrowserPanelContextValue = {
    isOpen,
    togglePanel,
    openPanel,
    closePanel,
    screenshots,
    addScreenshot,
    removeScreenshot,
    clearScreenshots,
    selectedScreenshotId,
    selectScreenshot,
    busy,
    available,
    activeUrl,
    capture,
    openUrl,
    refresh,
  }

  return (
    <BrowserPanelContext.Provider value={value}>
      {children}
    </BrowserPanelContext.Provider>
  )
}

/**
 * Hook to access browser panel context.
 * @returns the browser panel context value.
 * @throws if used outside of BrowserPanelProvider.
 */
export function useBrowserPanel(): BrowserPanelContextValue {
  const context = useContext(BrowserPanelContext)
  if (context === null) {
    throw new Error('useBrowserPanel must be used within a BrowserPanelProvider')
  }
  return context
}
