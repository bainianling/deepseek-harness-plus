/**
 * Shell frame, registered into the built-in 'root' slot (the web shell renders
 * only 'root'). Owns the app-level nav rail (section switching between the
 * harness work area and the application sections) and, inside the work area,
 * the three-column grid tracks (sidebar | center | details), the drag handles
 * (pointer capture + rAF throttle), the concession chain (columns.ts), and the
 * child-slot render decisions: the sidebar slot renders HERE with live
 * parameters from the concession solve, and the session-aware occupants render
 * in fixed column positions; strict entries gate themselves on
 * current-session availability while session-maybe entries retain identity.
 * Leaving the work section HIDES the work shell rather than unmounting it, so
 * a running session keeps streaming while another application section is shown.
 * Pure component: everything arrives through the three framework shares —
 * zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import {
  IconApiOutline14,
  IconChipOutline16,
  IconCodeOutline16,
  IconGaugeOutline16,
  IconKnowledgeOutline16,
  IconNetworkOutline16,
  IconNewsOutline16,
  IconRefreshOutline16,
  IconStoreOutline16,
  IconVoiceOutline16,
  WallpaperLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  computeColumns, NAVRAIL_WIDTH, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT,
} from './columns.ts'
import { CollabStudioApp } from './CollabStudioApp.tsx'
import { DocumentTitle } from './DocumentTitle.tsx'
import { KnowledgeHubApp } from './KnowledgeHubApp.tsx'
import { LoraTrainApp } from './LoraTrainApp.tsx'
import { ModelBenchApp } from './ModelBenchApp.tsx'
import { NewsPanel } from './NewsPanel.tsx'
import { SkillMarketApp } from './SkillMarketApp.tsx'
import { TerminalApp } from './TerminalApp.tsx'
import { VoiceCloneApp } from './VoiceCloneApp.tsx'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** One app-level navigation section of the left nav rail. */
export type NavSection = 'work' | 'terminal' | 'voice' | 'news' | 'lora' | 'collab' | 'bench' | 'knowledge' | 'market'

/** Nav-rail glyph shape shared by every section icon component. */
type NavIcon = (props: { size?: number; className?: string }) => ReactElement

/** Section definition: stable id + rail glyph + common-namespace label key. */
interface NavSectionSpec {
  id: NavSection
  icon: NavIcon
  labelKey: 'nav.work' | 'nav.terminal' | 'nav.voiceClone' | 'nav.news' | 'nav.lora' | 'nav.collab' | 'nav.bench' | 'nav.knowledge' | 'nav.market'
}

/** The nav sections in rail order: the harness work area first. */
const NAV_SECTIONS: readonly NavSectionSpec[] = [
  { id: 'work', icon: IconCodeOutline16, labelKey: 'nav.work' },
  { id: 'terminal', icon: IconApiOutline14, labelKey: 'nav.terminal' },
  { id: 'voice', icon: IconVoiceOutline16, labelKey: 'nav.voiceClone' },
  { id: 'news', icon: IconNewsOutline16, labelKey: 'nav.news' },
  { id: 'lora', icon: IconChipOutline16, labelKey: 'nav.lora' },
  { id: 'collab', icon: IconNetworkOutline16, labelKey: 'nav.collab' },
  { id: 'bench', icon: IconGaugeOutline16, labelKey: 'nav.bench' },
  { id: 'knowledge', icon: IconKnowledgeOutline16, labelKey: 'nav.knowledge' },
  { id: 'market', icon: IconStoreOutline16, labelKey: 'nav.market' },
]

/** localStorage key persisting the active nav section across reloads. */
const NAV_STORAGE_KEY = 'dsh.navSection'

/** Read the persisted nav section; anything unrecognized falls back to work. */
function readStoredNavSection(): NavSection {
  try {
    const stored = window.localStorage.getItem(NAV_STORAGE_KEY)
    if (stored === 'work' || stored === 'terminal' || stored === 'voice' || stored === 'news' || stored === 'lora' || stored === 'collab' || stored === 'bench' || stored === 'knowledge' || stored === 'market') return stored
  } catch { /* storage unavailable (private mode, embedded frame) — use default */ }
  return 'work'
}

/** Persist the nav section; a storage failure only loses the persistence. */
function storeNavSection(id: NavSection): void {
  try { window.localStorage.setItem(NAV_STORAGE_KEY, id) } catch { /* non-fatal */ }
}

/**
 * The app-level nav rail: one icon+label button per section. The rail is the
 * frame's first grid track; the work shell and application panes share the
 * remaining track (auto placement, one of them hidden at a time).
 */
function NavRail({ section, onNavigate, t }: {
  section: NavSection
  onNavigate: (id: NavSection) => void
  t: AppFrameProps['t']
}) {
  return (
    <nav className={css.navRail} aria-label={t('nav.label')}>
      {NAV_SECTIONS.map((item) => {
        const active = section === item.id
        return (
          <button
            key={item.id}
            type="button"
            className={`${css.navItem}${active ? ` ${css.navItemActive}` : ''}`}
            data-active={active || undefined}
            data-section={item.id}
            aria-label={t(item.labelKey)}
            onClick={() => { onNavigate(item.id) }}
          >
            <span className={css.navIcon} aria-hidden="true">
              {item.icon({ size: 20 })}
            </span>
            <span className={css.navLabel}>{t(item.labelKey)}</span>
          </button>
        )
      })}
    </nav>
  )
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>

/** Read the optional target viewport embedded in a LAN-share URL. */
function sharedViewport(): { width: number; height: number } | undefined {
  const value = new URLSearchParams(window.location.search).get('dsh-viewport')
  const match = value === null ? null : /^(\d{1,4})x(\d{1,4})$/u.exec(value)
  if (match === null) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 240 || width > 2560 || height < 320 || height > 3840) return undefined
  return { width, height }
}

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  useCurrentSession,
  actions,
  renderSlot,
  SessionProvider,
  t,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const currentSession = (useCurrentSession ?? (() => undefined))(value => value)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const documentTitle = useSessions((s) => {
    const current = s.current
    return current === undefined ? undefined : s.byId[current]?.title
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const targetViewport = useMemo(sharedViewport, [])
  const [viewport, setViewport] = useState(() => window.innerWidth)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a narrow re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze.
  const sharedMobileLayout = targetViewport !== undefined && targetViewport.width < SIDEBAR_AUTO_COLLAPSE
  // The nav rail is a permanently open panel left of the sidebar: the
  // concession chain solves against the viewport minus the rail width, so the
  // work area absorbs the rail exactly like a fixed-width column.
  const navVisible = !sharedMobileLayout
  const workViewport = navVisible ? Math.max(0, viewport - NAVRAIL_WIDTH) : viewport
  const narrow = sharedMobileLayout || workViewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = sharedMobileLayout || (narrow ? !panels.narrowExpanded : panels.sidebar === 0)
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const resolvedColumns = computeColumns(workViewport, sidebarPreference, detailsSession === undefined ? 0 : panels.details)
  // A target-phone share is deliberately one-column: desktop side rails consume
  // too much of the real device viewport even when the browser is wider than
  // the requested target width.
  const cols = sharedMobileLayout
    ? { sidebar: 0, center: workViewport, details: 0 }
    : resolvedColumns
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')

  // App-level nav section state (persisted). A shared-phone view always shows
  // the work area regardless of the locally persisted section: the share
  // target is the harness conversation itself.
  const [navSection, setNavSection] = useState<NavSection>(readStoredNavSection)
  const onNavigate = useCallback((id: NavSection) => {
    setNavSection(id)
    storeNavSection(id)
  }, [])
  const effectiveSection: NavSection = navVisible ? navSection : 'work'
  const onWorkSection = effectiveSection === 'work'

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        gridTemplateColumns: navVisible
          ? `${String(NAVRAIL_WIDTH)}px minmax(0, 1fr)`
          : 'minmax(0, 1fr)',
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-shared-mobile-layout={sharedMobileLayout || undefined}
      data-shared-viewport={targetViewport === undefined ? undefined : `${String(targetViewport.width)}x${String(targetViewport.height)}`}
      data-dragging={dragging || undefined}
      data-nav-section={effectiveSection}
    >
      <DocumentTitle
        productTitle={productTitle}
        {...documentTitle === undefined ? {} : { title: documentTitle }}
      />
      {/* Full-screen wallpaper (image/video) behind every column; the layer is
          fixed at z-index -1 and only paints when a wallpaper is active. */}
      <WallpaperLayer />
      {navVisible && <NavRail section={effectiveSection} onNavigate={onNavigate} t={t} />}
      <div
        className={css.workShell}
        style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` }}
        data-nav-hidden={!onWorkSection || undefined}
      >
        <div className={css.sidebarCol}>
          {/* Render-site slot call with live concession output: a closed
              sidebar keeps the mounted slot at the compact-rail width, and the
              component sees its rendered state as owner params decided here
              (collapsed follows the resolved rail, so a derived auto-collapse
              renders the rail UI too). */}
          {!sharedMobileLayout && renderSlot('sidebar', {
            collapsed: sidebarCollapsed,
            width: cols.sidebar,
          })}
        </div>
        <>
          {/* Both column occupants stay at fixed tree positions from first
              paint — no loading gate: a bare status line reads worse than
              the shell's own pending rendering. The conversation
              is session-maybe; SessionProvider withholds the strict details
              entry while no session is current. */}
          <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
          <DetailsColumn>
            <SessionProvider>{renderSlot('details', {})}</SessionProvider>
          </DetailsColumn>
        </>
        {/* Drag handles are work-shell children: their inline `left` is
            relative to the work area (the nav rail sits outside it). */}
        {!sharedMobileLayout && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
        {!sharedMobileLayout && cols.details > 0 && <DragHandle side="details" left={workViewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
      </div>
      {/* Application sections keep the work shell mounted-but-hidden beside
          them, so switching back is instant and session streams never drop. */}
      {!onWorkSection && effectiveSection === 'terminal' && <TerminalApp session={currentSession} t={t} />}
      {!onWorkSection && effectiveSection === 'voice' && <VoiceCloneApp t={t} />}
      {!onWorkSection && effectiveSection === 'news' && <NewsPanel t={t} />}
      {!onWorkSection && effectiveSection === 'collab' && <CollabStudioApp t={t} />}
      {!onWorkSection && effectiveSection === 'lora' && <LoraTrainApp t={t} />}
      {!onWorkSection && effectiveSection === 'bench' && <ModelBenchApp t={t} />}
      {!onWorkSection && effectiveSection === 'knowledge' && <KnowledgeHubApp t={t} />}
      {!onWorkSection && effectiveSection === 'market' && <SkillMarketApp t={t} />}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* Shell-level reload control pinned to the top-right, immediately LEFT of
          the dsh-better-sidebar toggle cluster (bottom-panel + right-panel
          buttons own the extreme corner). It lives on the frame — which always
          renders — so it stays clickable even when a session view is blank or
          stalled. Wide: cluster is 60px (two 28px + 4px gap) at right:10, so the
          refresh sits at right:74; narrow hides the bottom button (28px) → 42. */}
      <button
        type="button"
        className={css.refresh}
        style={{ right: narrow ? 42 : 74 }}
        aria-label={t('refresh')}
        title={t('refresh')}
        onClick={() => { window.location.reload() }}
      >
        <IconRefreshOutline16 size={16} />
      </button>
    </div>
  )
}
