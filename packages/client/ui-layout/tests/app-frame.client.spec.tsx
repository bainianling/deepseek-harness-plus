// @vitest-environment jsdom
/**
 * AppFrame interaction spec under the four-share props form: real layout
 * store instance (createLayoutStore().create() — the test-sanctioned engine
 * path), a recording renderSlot stub, and a SessionProvider component stub
 * (the real one is framework-wired to the renderer host; its own behavior is
 * ui-renderer's spec territory). Drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, and details staying mounted at
 * zero width are the preserved behavior assertions. jsdom has no layout
 * engine, so the frame width comes from a mocked getBoundingClientRect and
 * resizes are driven through the ResizeObserver stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import { NAVRAIL_WIDTH, SIDEBAR_COLLAPSED } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// Session selection controls for the SessionProvider and useSessions stubs.
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
const selectedSessionTitle = { current: undefined as string | undefined }
const workspacesReady = { current: true }
type AttentionSnapshot = Parameters<Parameters<AppFrameProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: AppFrameProps['useSessionPendingInteraction'] = selector => selector(noAttention)

// Provider contract stub fed through the standard seat prop (the renderer
// injects the real one in production): session mode renders children and
// empty mode runs the empty branch.
const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ children, empty }) =>
  selectedSession.current === undefined ? <>{empty?.() ?? null}</> : <>{children}</>


/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920

/**
 * Injected creation capability stub. The frame only hands it to the
 * conversation-create pane, so every spec outside that pane never calls it;
 * `listOptions` resolves so the pane's own mount effect settles.
 */
const createConversationStub: AppFrameProps['createConversation'] = {
  create: () => Promise.reject(new Error('createConversation.create is not exercised by AppFrame specs')),
  listOptions: () => Promise.resolve({
    presets: [], providers: [], routableProviders: [], failures: [],
  }),
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function mountFrame() {
  window.innerWidth = frameWidth // first-render viewport source before the observer fires
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return <div data-testid="center-content" />
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const current = selectedSession.current
    const sessionState = {
      ids: current === undefined ? [] : [current],
      byId: current === undefined
        ? {}
        : {
          [current]: {
            id: current,
            displayTitle: 'Test',
            running: false,
            blank: selectedSessionBlank.current,
            updatedAt: 1,
            ...(selectedSessionTitle.current === undefined ? {} : { title: selectedSessionTitle.current }),
          },
        },
      current,
      phase: 'ready',
    } as SessionListState
    return sel(sessionState)
  }) as never
  const workspaceState: WorkspaceSnapshot = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    ...(workspacesReady.current ? {} : { state: 'loading' as const, phase: 'pending' as const }),
  }
  const element = () => (
    <AppFrame
      useStore={hookOf(instance)}
      actions={instance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useSessionPendingInteraction={useSessionPendingInteraction}
      useWorkspaces={((sel: (s: WorkspaceSnapshot) => unknown) => sel(workspaceState)) as never}
      createConversation={createConversationStub}
      SessionProvider={SessionProviderStub}
      t={key => key === 'brand.localBuild' ? 'DSH Local Build' : key}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return { instance, frame, slotCalls, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

/** The three-column work shell inside the frame (right of the nav rail). */
function workShell(frame: HTMLElement): HTMLElement {
  const shell = frame.querySelector('[class*="workShell"]')
  if (shell === null) throw new Error('missing work shell')
  return shell as HTMLElement
}

function tracks(frame: HTMLElement): number[] {
  const template = workShell(frame).style.gridTemplateColumns
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px$/.exec(template)
  if (m === null) throw new Error(`unexpected template: ${template}`)
  return [Number(m[1]), Number(m[2])]
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  frameWidth = 1920
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  selectedSessionTitle.current = undefined
  workspacesReady.current = true
  // The nav section persists in localStorage; specs start from a clean slate.
  window.localStorage.clear()
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  Element.prototype.getBoundingClientRect = function () {
    return { width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080, x: 0, y: 0, toJSON: () => ({}) }
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  document.title = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('AppFrame', () => {
  it('localizes the product title when the build does not supply one', () => {
    mountFrame()
    expect(document.title).toBe('DSH Local Build')
  })

  it('projects the selected durable Session title', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'Product')
    selectedSessionTitle.current = 'First'
    const { rerenderFrame } = mountFrame()
    expect(document.title).toBe('First — Product')

    selectedSessionTitle.current = 'Revised'
    act(() => { rerenderFrame() })
    expect(document.title).toBe('Revised — Product')

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(document.title).toBe('Product')
  })

  it('renders three tracks from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('renders the session pair with empty owner shares (sessionId is framework-standard)', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('details')
    expect(keys).not.toContain('conversation.empty')
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // No current session: the session-maybe conversation shell owns the New
    // Session view itself — the center column renders it unconditionally.
    selectedSession.current = undefined
    const { slotCalls, getByTestId, queryByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(queryByTestId('details-content')).toBeNull()
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // No loading gate: a bare loading status reads worse than the shell's own
    // pending rendering — both occupants mount from first paint.
    workspacesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('ignores unselected states and closes only when the Session id changes', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(360)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280 })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    // Step-2 squeeze: details renders 330 while preference is 360. The frame
    // is NAVRAIL_WIDTH wider than the work area the concession chain sees.
    frameWidth = 1250 + NAVRAIL_WIDTH
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 330])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // shrink by 10 from the rendered width
    expect(instance.getSnapshot().details).toBe(320)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250 + NAVRAIL_WIDTH // work area 1250: step-2 squeeze
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360])
  })

  it('drag handles disappear for collapsed columns', () => {
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — LAN target viewport', () => {
  it('uses a shared phone target as a single-column layout on any actual viewport', () => {
    window.history.replaceState({}, '', '/?dsh-viewport=390x844')
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([0, 0])
    expect(frame.style.gridTemplateColumns).toBe('minmax(0, 1fr)')
    expect(frame.getAttribute('data-shared-viewport')).toBe('390x844')
    expect(frame.hasAttribute('data-shared-mobile-layout')).toBe(true)
    expect(slotCalls.map(call => call.key)).not.toContain('sidebar')
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('hides the nav rail and forces the work section on a shared phone target', () => {
    window.history.replaceState({}, '', '/?dsh-viewport=390x844')
    window.localStorage.setItem('dsh.navSection', 'news')
    const { frame } = mountFrame()
    expect(frame.querySelector('[class*="navRail"]')).toBeNull()
    expect(frame.getAttribute('data-nav-section')).toBe('work')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(false)
    expect(frame.querySelector('[class*="placeholderPane"]')).toBeNull()
  })
})

describe('AppFrame — nav rail sections', () => {
  function navItems(frame: HTMLElement): HTMLElement[] {
    return [...frame.querySelectorAll('[class*="navItem"]')] as HTMLElement[]
  }

  function clickNav(frame: HTMLElement, section: string): void {
    const item = frame.querySelector(`[data-section="${section}"]`)
    if (item === null) throw new Error(`missing nav item: ${section}`)
    act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }

  it('renders the rail with ten sections and work active by default', () => {
    const { frame } = mountFrame()
    expect(frame.style.gridTemplateColumns).toBe(`${String(NAVRAIL_WIDTH)}px minmax(0, 1fr)`)
    expect(frame.getAttribute('data-nav-section')).toBe('work')
    const items = navItems(frame)
    expect(items).toHaveLength(10)
    expect(items.map(item => item.dataset.section)).toEqual(['work', 'conversationCreate', 'terminal', 'voice', 'news', 'lora', 'collab', 'bench', 'knowledge', 'market'])
    expect(items[0]!.hasAttribute('data-active')).toBe(true)
    expect(items[1]!.hasAttribute('data-active')).toBe(false)
  })

  it('exposes the conversation-create section under its own label', () => {
    const { frame } = mountFrame()
    const item = frame.querySelector('[data-section="conversationCreate"]')
    expect(item?.getAttribute('aria-label')).toBe('nav.conversationCreate')
  })

  it('the conversation-create section renders its pane against the injected capability', async () => {
    const { frame } = mountFrame()
    await act(async () => {
      clickNav(frame, 'conversationCreate')
      await Promise.resolve()
    })
    expect(frame.getAttribute('data-nav-section')).toBe('conversationCreate')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
    expect(window.localStorage.getItem('dsh.navSection')).toBe('conversationCreate')
    // The pane is a real region keyed on the same nav label, not a placeholder.
    const pane = frame.querySelector('[role="region"][aria-label="nav.conversationCreate"]')
    expect(pane).not.toBeNull()
    expect(frame.querySelector('[class*="placeholderPane"]')).toBeNull()
  })

  it('switching to a non-work section hides the work shell without unmounting it', () => {
    const { frame, getByTestId } = mountFrame()
    clickNav(frame, 'lora')
    expect(frame.getAttribute('data-nav-section')).toBe('lora')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
    // The session slots stay mounted behind the section pane.
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    expect(window.localStorage.getItem('dsh.navSection')).toBe('lora')
  })

  it('the news section renders the live news panel instead of the placeholder', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ updatedAt: 0, crawling: false, platforms: [], items: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { frame } = mountFrame()
      await act(async () => {
        const item = frame.querySelector('[data-section="news"]')
        if (item === null) throw new Error('missing nav item: news')
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(frame.getAttribute('data-nav-section')).toBe('news')
      expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
      expect(frame.querySelector('[class*="placeholderPane"]')).toBeNull()
      expect(frame.querySelector('[role="region"][aria-label="news.title"]')).toBeTruthy()
      expect(frame.querySelectorAll('[class*="chip"]').length).toBeGreaterThan(0)
      expect(fetchMock).toHaveBeenCalledWith('/api/ai-news/feed', expect.objectContaining({ cache: 'no-store' }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens a translated news card through the built-in browser event', async () => {
    const link = 'https://www.theverge.com/ai/example'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        updatedAt: 1,
        crawling: false,
        platforms: [{ id: 'rss', label: '综合', ok: true, count: 1 }],
        items: [{
          id: 'rss:1', platform: 'rss', title: 'Original English title', translatedTitle: '中文标题',
          summary: 'English summary', translatedSummary: '中文摘要', link, publishedAt: Date.now(), aiScore: 3,
        }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    let openedUrl = ''
    const onOpen = (event: Event): void => {
      const custom = event as CustomEvent<{ url: string; onResult?: (opened: boolean) => void }>
      openedUrl = custom.detail.url
      event.preventDefault()
      custom.detail.onResult?.(true)
    }
    window.addEventListener('dsh-browser-panel:open', onOpen)
    try {
      const { frame } = mountFrame()
      await act(async () => {
        clickNav(frame, 'news')
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(frame.textContent).toContain('中文标题')
      expect(frame.textContent).toContain('中文摘要')
      const card = frame.querySelector(`a[href="${link}"]`)
      if (card === null) throw new Error('missing news card')
      const nativeDefaultAllowed = card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(nativeDefaultAllowed).toBe(false)
      expect(openedUrl).toBe(link)
    } finally {
      window.removeEventListener('dsh-browser-panel:open', onOpen)
      vi.unstubAllGlobals()
    }
  })

  it('offers the douyin login banner until the browser session is logged in', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/api/ai-news/douyin/auth')) {
        return { ok: true, json: async () => ({ supported: true, profileConfigured: true, loggedIn: false }) }
      }
      if (url.includes('/api/ai-news/douyin/login/complete') && method === 'POST') {
        return { ok: true, json: async () => ({ loggedIn: true }) }
      }
      if (url.includes('/api/ai-news/douyin/login') && method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, url: 'https://www.douyin.com/' }) }
      }
      return {
        ok: true,
        json: async () => ({ updatedAt: 1, crawling: false, platforms: [], items: [] }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    let showEvents = 0
    const onShow = (event: Event): void => {
      event.preventDefault()
      showEvents += 1
    }
    window.addEventListener('dsh-browser-panel:show', onShow)
    try {
      const { frame } = mountFrame()
      await act(async () => {
        clickNav(frame, 'news')
        await Promise.resolve()
        await Promise.resolve()
      })
      const banner = frame.querySelector('[data-testid="news-douyin-login"]')
      expect(banner).not.toBeNull()
      const loginButton = banner!.querySelector('button')
      expect(loginButton!.textContent).toContain('登录抖音')
      await act(async () => {
        loginButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(showEvents).toBe(1)
      const doneButton = frame.querySelector('[data-testid="news-douyin-login"] button')
      expect(doneButton!.textContent).toContain('已在浏览器面板完成登录')
      await act(async () => {
        doneButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(frame.querySelector('[data-testid="news-douyin-login"]')).toBeNull()
    } finally {
      window.removeEventListener('dsh-browser-panel:show', onShow)
      vi.unstubAllGlobals()
    }
  })

  it('the collab section renders the collaboration studio instead of the placeholder', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input)
      if (url.includes('/api/collab/meta')) {
        return { ok: true, json: async () => ({ roles: [], stages: [], projectTypes: ['software'] }) }
      }
      if (url.includes('/api/collab/models')) {
        return { ok: true, json: async () => ({ default: null, providers: [] }) }
      }
      if (url.includes('/api/collab/projects')) {
        return { ok: true, json: async () => ({ projects: [] }) }
      }
      return { ok: false, json: async () => ({ error: 'unexpected' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { frame } = mountFrame()
      await act(async () => {
        const item = frame.querySelector('[data-section="collab"]')
        if (item === null) throw new Error('missing nav item: collab')
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(frame.getAttribute('data-nav-section')).toBe('collab')
      expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
      expect(frame.querySelector('[class*="placeholderPane"]')).toBeNull()
      expect(frame.querySelector('[role="region"][aria-label="collab.title"]')).toBeTruthy()
      const calledUrls = fetchMock.mock.calls.map(call => String(call[0]))
      expect(calledUrls).toContain('/api/collab/meta')
      expect(calledUrls).toContain('/api/collab/models')
      expect(calledUrls).toContain('/api/collab/projects')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the bench section renders the model testing bench instead of the placeholder', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input)
      if (url.includes('/api/bench/meta')) {
        return { ok: true, json: async () => ({ categories: [{ id: 'coding', title: '编程', description: 'd' }], limits: { maxContestantsPerRound: 12 } }) }
      }
      if (url.includes('/api/bench/models')) {
        return { ok: true, json: async () => ({ default: null, providers: [] }) }
      }
      if (url.includes('/api/bench/rounds')) {
        return { ok: true, json: async () => ({ rounds: [] }) }
      }
      return { ok: false, json: async () => ({ error: 'unexpected' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { frame } = mountFrame()
      await act(async () => {
        const item = frame.querySelector('[data-section="bench"]')
        if (item === null) throw new Error('missing nav item: bench')
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(frame.getAttribute('data-nav-section')).toBe('bench')
      expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
      expect(frame.querySelector('[class*="placeholderPane"]')).toBeNull()
      expect(frame.querySelector('[role="region"][aria-label="bench.title"]')).toBeTruthy()
      const calledUrls = fetchMock.mock.calls.map(call => String(call[0]))
      expect(calledUrls).toContain('/api/bench/meta')
      expect(calledUrls).toContain('/api/bench/models')
      expect(calledUrls).toContain('/api/bench/rounds')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('submits the selected bench difficulty when creating a round', async () => {
    const created = {
      id: 'round-hard', name: 'Hard round', category: 'coding', difficulty: 'hard', createdAt: 2,
      status: 'generating', modelCount: 0, models: [], contestants: {},
    }
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/bench/meta') {
        return { ok: true, json: async () => ({ categories: [{ id: 'coding', title: 'Coding', description: 'd' }], limits: { maxContestantsPerRound: 12 } }) }
      }
      if (url === '/api/bench/models') return { ok: true, json: async () => ({ default: null, providers: [] }) }
      if (url === '/api/bench/rounds' && init?.method === 'POST') return { ok: true, json: async () => ({ record: created }) }
      if (url === '/api/bench/rounds') return { ok: true, json: async () => ({ rounds: [] }) }
      if (url === '/api/bench/rounds/round-hard') return { ok: true, json: async () => ({ record: created, question: null }) }
      if (url.startsWith('/api/bench/rounds/round-hard/events')) return { ok: true, json: async () => ({ events: [], total: 0 }) }
      return { ok: false, json: async () => ({ error: 'unexpected' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { frame, getAllByText, getByText } = mountFrame()
    await act(async () => {
      frame.querySelector<HTMLElement>('[data-section="bench"]')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      getAllByText('bench.new')[0]?.click()
      await Promise.resolve()
    })
    expect(frame.querySelector('[data-active="true"]')?.textContent).not.toBeNull()
    await act(async () => {
      getByText('bench.difficulty.hard').click()
      await Promise.resolve()
    })
    await act(async () => {
      getByText('bench.form.submit').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const post = fetchMock.mock.calls.find(call => String(call[0]) === '/api/bench/rounds' && call[1]?.method === 'POST')
    expect(post).toBeDefined()
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ category: 'coding', difficulty: 'hard', start: true })
  })

  it('allows a stopped bench round without a question to generate again', async () => {
    const round = {
      id: 'round-stopped', name: 'Interrupted round', category: 'coding', difficulty: 'medium', createdAt: 1,
      status: 'stopped', modelCount: 0, models: [], contestants: {},
      error: 'interrupted',
    }
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/bench/meta') {
        return { ok: true, json: async () => ({ categories: [{ id: 'coding', title: 'Coding', description: 'd' }], limits: { maxContestantsPerRound: 12 } }) }
      }
      if (url === '/api/bench/models') return { ok: true, json: async () => ({ default: null, providers: [] }) }
      if (url === '/api/bench/rounds') return { ok: true, json: async () => ({ rounds: [round] }) }
      if (url === '/api/bench/rounds/round-stopped') return { ok: true, json: async () => ({ record: round, question: null }) }
      if (url.startsWith('/api/bench/rounds/round-stopped/events')) return { ok: true, json: async () => ({ events: [], total: 0 }) }
      return { ok: false, json: async () => ({ error: 'unexpected' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { frame, getByText } = mountFrame()
      await act(async () => {
        frame.querySelector<HTMLElement>('[data-section="bench"]')?.click()
        await Promise.resolve()
      })
      await act(async () => {
        getByText('Interrupted round').click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(getByText('bench.action.generate')).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the lora section renders the LoRA training studio instead of the placeholder', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input)
      if (url.includes('/api/lora/status')) {
        return { ok: true, json: async () => ({ service: 'dsh-lora-service', online: true, gpu: {}, busy: false, training_running: false }) }
      }
      if (url.includes('/api/lora/train/status')) {
        return { ok: true, json: async () => ({ running: false, current_step: 0, total_steps: 0, loss: null, loss_history: [], speed: '', eta: '', elapsed: '', error: '', samples: [], log_tail: [] }) }
      }
      if (url.includes('/api/lora/basemodels')) {
        return { ok: true, json: async () => ([{ name: 'Juggernaut-XL_v9.safetensors', path: 'E:/ckpt.safetensors', size_gb: 6.6, family: 'sdxl', managed: false }]) }
      }
      if (url.includes('/api/lora/datasets')) {
        return { ok: true, json: async () => ([{ name: 'goutou', images: 24, captioned: 24 }]) }
      }
      if (url.includes('/api/lora/outputs')) {
        return { ok: true, json: async () => ([{ name: 'goutou.safetensors', size_mb: 162.6, mtime: 1 }]) }
      }
      return { ok: false, json: async () => ({ error: 'unexpected' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { frame } = mountFrame()
      await act(async () => {
        const item = frame.querySelector('[data-section="lora"]')
        if (item === null) throw new Error('missing nav item: lora')
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(frame.getAttribute('data-nav-section')).toBe('lora')
      expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
      expect(frame.querySelector('[class*="placeholderPane"]')).toBeNull()
      expect(frame.querySelector('[role="region"][aria-label="lora.title"]')).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the knowledge section renders the knowledge center without unmounting work', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/knowledge/status') {
        return {
          ok: true,
          json: async () => ({
            status: 'online',
            errorCode: null,
            message: null,
            startedAt: '2026-08-30T00:00:00Z',
            source: { kind: 'hindsight', bankId: 'coding-agent::deepseek-harness', readOnly: true },
          }),
        }
      }
      if (url === '/api/knowledge/snapshot') {
        return {
          ok: true,
          json: async () => ({
            source: { kind: 'hindsight', status: 'online', bankId: 'coding-agent::deepseek-harness', readOnly: true, syncedAt: '2026-08-30T00:00:00Z' },
            folders: [{ id: 'kf-1', name: 'Architecture', parentId: null, depth: 0, path: ['Architecture'], pageCount: 1 }],
            pages: [{ id: 'kp-1', name: 'Architecture guide', description: 'System boundaries', folderId: 'kf-1', folderPath: ['Architecture'], tags: [], updatedAt: '2026-08-30T00:00:00Z', stale: false, managed: false }],
            stats: {
              facts: 182,
              links: 2532,
              documents: 12,
              observations: 84,
              pendingOperations: 2,
              failedOperations: 3,
              pendingConsolidation: 0,
              failedConsolidation: 0,
              lastConsolidatedAt: null,
              lastMemoryWriteAt: null,
              factsByType: {},
              operationsByStatus: {},
            },
            tags: [],
          }),
        }
      }
      if (url === '/api/knowledge/pages/kp-1') {
        return { ok: true, json: async () => ({ page: { id: 'kp-1', name: 'Architecture guide', type: 'knowledge-page', description: 'System boundaries', tags: [], timestamp: '2026-08-30T00:00:00Z', body: '## Boundaries\n\nHost owns routes.', markdown: '' } }) }
      }
      return { ok: false, status: 404, json: async () => ({ error: 'unexpected route' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { frame, getByTestId } = mountFrame()
    clickNav(frame, 'knowledge')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(frame.getAttribute('data-nav-section')).toBe('knowledge')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.querySelector('[class*="placeholderPane"]')).toBeNull()
    expect(frame.querySelector('[role="region"][aria-label="nav.knowledge"]')).toBeTruthy()
    expect(frame.textContent).toContain('Architecture guide')
    expect(fetchMock).toHaveBeenCalledWith('/api/knowledge/snapshot', { cache: 'no-store' })
    expect(window.localStorage.getItem('dsh.navSection')).toBe('knowledge')
  })

  it('keeps Knowledge offline until an explicit start, then polls to online', async () => {
    let statusCalls = 0
    let startCalls = 0
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/knowledge/status') {
        statusCalls++
        const state = statusCalls === 1
          ? { status: 'offline', errorCode: null, message: null, startedAt: null }
          : statusCalls === 2
            ? { status: 'starting', errorCode: null, message: null, startedAt: null }
            : { status: 'online', errorCode: null, message: null, startedAt: '2026-08-30T00:00:00Z' }
        return {
          ok: true,
          json: async () => ({
            ...state,
            source: { kind: 'hindsight', bankId: 'coding-agent::deepseek-harness', readOnly: true },
          }),
        }
      }
      if (url === '/api/knowledge/start') {
        startCalls++
        return {
          ok: true,
          json: async () => ({
            status: 'starting',
            errorCode: null,
            message: null,
            startedAt: null,
            source: { kind: 'hindsight', bankId: 'coding-agent::deepseek-harness', readOnly: true },
          }),
        }
      }
      if (url === '/api/knowledge/snapshot') {
        return {
          ok: true,
          json: async () => ({
            source: { kind: 'hindsight', status: 'online', bankId: 'coding-agent::deepseek-harness', readOnly: true, syncedAt: '2026-08-30T00:00:00Z' },
            folders: [{ id: 'kf-1', name: 'Architecture', parentId: null, depth: 0, path: ['Architecture'], pageCount: 1 }],
            pages: [{ id: 'kp-1', name: 'Architecture guide', description: 'System boundaries', folderId: 'kf-1', folderPath: ['Architecture'], tags: [], updatedAt: '2026-08-30T00:00:00Z', stale: false, managed: false }],
            stats: {
              facts: 1, links: 2, documents: 3, observations: 4,
              pendingOperations: 0, failedOperations: 0,
              pendingConsolidation: 0, failedConsolidation: 0,
              lastConsolidatedAt: null, lastMemoryWriteAt: null,
              factsByType: {}, operationsByStatus: {},
            },
            tags: [],
          }),
        }
      }
      if (url === '/api/knowledge/pages/kp-1') {
        return { ok: true, json: async () => ({ page: { id: 'kp-1', name: 'Architecture guide', type: 'knowledge-page', description: 'System boundaries', tags: [], timestamp: '2026-08-30T00:00:00Z', body: '## Boundaries', markdown: '' } }) }
      }
      return { ok: false, status: 404, json: async () => ({ error: 'unexpected route' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const { frame } = mountFrame()
    clickNav(frame, 'knowledge')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const panel = frame.querySelector('[class*="daemonPanel"]')
    if (!(panel instanceof HTMLElement)) throw new Error('missing daemon panel')
    expect(panel.textContent).toContain('knowledge.daemon.offline')
    const startButton = panel.querySelector('button')
    if (!(startButton instanceof HTMLButtonElement)) throw new Error('missing Hindsight start button')
    act(() => {
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      startButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(startCalls).toBe(1)
    expect(panel.textContent).toContain('knowledge.daemon.starting')

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(statusCalls).toBe(2)
    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(statusCalls).toBe(3)
    expect(frame.textContent).toContain('Architecture guide')
    expect(fetchMock).toHaveBeenCalledWith('/api/knowledge/start', { method: 'POST', cache: 'no-store' })
    expect(fetchMock).toHaveBeenCalledWith('/api/knowledge/snapshot', { cache: 'no-store' })
  })

  it('the skill market renders the searchable catalog without unmounting work', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fetchedAt: '2026-08-30T00:00:00Z', cached: false,
        sources: [{ id: 'baseline', label: 'DSH 审计基线', url: 'https://github.com/deepseek-ai/deepseek-harness', status: 'online', count: 1 }],
        items: [{
          id: 'skill:test', kind: 'skill', name: 'Searchable Skill', publisher: 'tester', description: 'Search tools safely',
          sourceUrl: 'https://skills.sh/tester/skills/searchable', codeUrl: 'https://github.com/tester/skills', registry: 'skills.sh',
          publishedAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-30T00:00:00Z', stars: 120, language: 'Markdown', license: 'MIT',
          install: 'npx skills add tester/skills@searchable', risk: { level: 'low', confidence: 'declared', rationale: 'Prompt only', signals: ['提示词 / 文档'] }, tags: ['search'],
        }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { frame, getByTestId } = mountFrame()
    await act(async () => {
      clickNav(frame, 'market')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(frame.getAttribute('data-nav-section')).toBe('market')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.querySelector('[class*="marketPlaceholder"]')).toBeNull()
    expect(frame.querySelector('[role="region"][aria-label="nav.market"]')).toBeTruthy()
    expect(frame.textContent).toContain('Searchable Skill')
    expect(frame.textContent).toContain('原项目地址')
    expect(fetchMock).toHaveBeenCalledWith('/api/market/catalog?sort=date', { cache: 'no-store' })
    expect(window.localStorage.getItem('dsh.navSection')).toBe('market')
  })

  it('switching back to work restores the shell and drops the section pane', () => {
    const { frame } = mountFrame()
    clickNav(frame, 'market')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
    clickNav(frame, 'work')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(false)
    expect(frame.querySelector('[class*="marketPlaceholder"]')).toBeNull()
    expect(window.localStorage.getItem('dsh.navSection')).toBe('work')
  })

  it('restores the persisted section on mount', () => {
    window.localStorage.setItem('dsh.navSection', 'voice')
    const { frame } = mountFrame()
    expect(frame.getAttribute('data-nav-section')).toBe('voice')
    expect(workShell(frame).hasAttribute('data-nav-hidden')).toBe(true)
  })

  it('an unrecognized persisted value falls back to work', () => {
    window.localStorage.setItem('dsh.navSection', 'bogus')
    const { frame } = mountFrame()
    expect(frame.getAttribute('data-nav-section')).toBe('work')
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })

  it('narrow toggle re-expands over the squeezed center and back', () => {
    frameWidth = 980
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
  })

  it('a wide-closed preference re-expands at the contract default while narrow', () => {
    frameWidth = 1920
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() }) // close while wide: preference 0
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().sidebar).toBe(0) // preference untouched
  })

  it('shrinking across the breakpoint auto-collapses; re-widening restores the drag width', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([280, 0])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250 + NAVRAIL_WIDTH // work area 1250: step-2 squeeze
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
  })
})
