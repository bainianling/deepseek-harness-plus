// @vitest-environment jsdom
/**
 * The three conversation-adjacent surfaces: the General-settings row naming the
 * default for later sessions, the new-session chip staging the next one's, and
 * the session header's picker committing a started session's swap between
 * turns. The split is the host's rule — `agentPreset.select` recomposes an
 * agent between turns, so before-the-fact surfaces stage and the header
 * commits.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentPresetLabel } from '../src/client/AgentPresetLabel.tsx'
import type { AgentPresetLabelProps } from '../src/client/AgentPresetLabel.tsx'
import { AgentPresetRow } from '../src/client/AgentPresetRow.tsx'
import type { AgentPresetRowProps } from '../src/client/AgentPresetRow.tsx'
import { AgentPresetSeat } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSeatProps } from '../src/client/AgentPresetSeat.tsx'
import type { AgentPresetSettingsState } from '../src/client/settings-store.ts'
import type { AgentPresetSeatState } from '../src/client/seat-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const ROW_READY: AgentPresetSettingsState = {
  status: 'ready',
  error: null,
  writable: true,
  currentValue: 'standard',
  // `mine` deliberately names itself nothing: the row must fall back to the
  // id for a preset whose author wrote no metadata.
  options: [{ id: 'standard', trust: 'system', name: '标准模式' }, { id: 'mine', trust: 'user' }],
}

const SEAT_READY: AgentPresetSeatState = {
  current: 'standard',
  options: [
    { id: 'standard', trust: 'system', name: '标准模式', description: '完整的编码 agent。' },
    { id: 'mine', trust: 'user' },
  ],
  busy: false,
  error: null,
  introduce: false,
}

function renderRow(state: Partial<AgentPresetSettingsState> = {}) {
  const store = createSnapshotStore<AgentPresetSettingsState>({ ...ROW_READY, ...state })
  const actions = { load: vi.fn(() => Promise.resolve()), select: vi.fn(() => Promise.resolve()) }
  render(<AgentPresetRow {...({
    ...actions,
    useAgentPreset: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetRowProps)} />)
  return actions
}

/** The runtime's own `{name}` substitution, so a test reads the shown text. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function renderSeat(
  state: Partial<AgentPresetSeatState> = {},
  select: () => Promise<string | undefined> = () => Promise.resolve(undefined),
) {
  const store = createSnapshotStore<AgentPresetSeatState>({ ...SEAT_READY, ...state })
  const actions = { load: vi.fn(() => Promise.resolve()), select: vi.fn(select), introduced: vi.fn() }
  render(<AgentPresetSeat {...({
    ...actions,
    useAgentPresetSeat: bindSnapshotSelector(store),
    t: translate,
  } as unknown as AgentPresetSeatProps)} />)
  return actions
}

function renderLabel(
  summary: { blank?: boolean; projectionValues?: { agentPreset?: string | null } } | undefined,
  roster: Partial<AgentPresetSettingsState> = {},
) {
  // The chip and the header picker read the same roster, metadata included.
  const store = createSnapshotStore<AgentPresetSettingsState>({
    ...ROW_READY, options: SEAT_READY.options, ...roster,
  })
  const sessions = createSnapshotStore({ byId: summary === undefined ? {} : { s1: summary } })
  const load = vi.fn(() => Promise.resolve())
  const switchPreset = vi.fn((_sessionId: string, _agentPreset: string) => Promise.resolve())
  const view = render(<AgentPresetLabel {...({
    load,
    switchPreset,
    sessionId: 's1',
    useSessions: bindSnapshotSelector(sessions),
    useAgentPresets: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as AgentPresetLabelProps)} />)
  return { load, switchPreset, view }
}

describe('the General-settings row', () => {
  it('reads the roster once and shows the current default', async () => {
    const actions = renderRow()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain(en.presetStandardName)
  })

  it('marks a locally authored option as local', () => {
    renderRow()

    fireEvent.click(screen.getByRole('button'))

    // A local preset is exactly as privileged as the plugins it names, so the
    // list says which rows are local rather than presenting all as vetted.
    expect(screen.getByText(`mine · ${en.userTrust}`)).toBeTruthy()
    // The shipped one carries no marker; only local rows are called out.
    expect(screen.getAllByText(en.presetStandardName)).toHaveLength(2)
  })

  it('falls back to the id for a preset that published no name', () => {
    renderRow({
      currentValue: 'mine',
      options: [
        { id: 'standard', trust: 'system', name: '标准模式' },
        { id: 'bare', trust: 'system' },
        { id: 'mine', trust: 'user' },
        { id: 'ours', trust: 'user', name: '团队模式' },
      ],
    })

    // The trigger names the preset; with no metadata the id is all there is.
    expect(screen.getByRole('button').textContent).toContain('mine')

    fireEvent.click(screen.getByRole('button'))

    // A locally authored preset is marked whether or not it named itself.
    expect(screen.getByText(`团队模式 · ${en.userTrust}`)).toBeTruthy()
    expect(screen.getByText(`mine · ${en.userTrust}`)).toBeTruthy()
    // A shipped preset with no metadata is listed by id and carries no mark.
    expect(screen.getByText('bare')).toBeTruthy()
  })

  it('shows the selected id until a stale roster contains it', () => {
    renderRow({ currentValue: 'arriving', options: [] })

    expect(screen.getByRole('button').textContent).toContain('arriving')
  })

  it('writes the picked preset and closes the menu', () => {
    const actions = renderRow()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.click(screen.getByText(`mine · ${en.userTrust}`))

    expect(actions.select).toHaveBeenCalledWith('mine')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on an outside dismissal', () => {
    renderRow()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('says it is loading before the roster answers', () => {
    renderRow({ status: 'loading', currentValue: '' })

    expect(screen.getByRole('button').textContent).toContain(en.loading)
    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
  })

  it('shows a failure in place of the description', () => {
    renderRow({ error: 'roster unavailable' })

    expect(screen.getByRole('alert').textContent).toBe('roster unavailable')
  })

  it('renders nothing when the deployment composes no presets', () => {
    const { container } = render(<AgentPresetRow {...({
      load: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve()),
      useAgentPreset: bindSnapshotSelector(
        createSnapshotStore<AgentPresetSettingsState>({ ...ROW_READY, status: 'unavailable', options: [] })),
      t: (key: keyof typeof en) => en[key],
    } as unknown as AgentPresetRowProps)} />)

    expect(container.firstChild).toBeNull()
  })

  it('closes and locks the menu when the settings turn read-only', () => {
    const store = createSnapshotStore<AgentPresetSettingsState>(ROW_READY)
    render(<AgentPresetRow {...({
      load: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve()),
      useAgentPreset: bindSnapshotSelector(store),
      t: (key: keyof typeof en) => en[key],
    } as unknown as AgentPresetRowProps)} />)
    fireEvent.click(screen.getByRole('button'))

    act(() => { store.set({ ...ROW_READY, writable: false }) })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
  })
})

describe('the new-session chip', () => {
  it('reads the roster once and shows the staged preset by name', async () => {
    const actions = renderSeat()

    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain(en.presetStandardName)
    expect(screen.getByRole('button').getAttribute('title')).toBe(en.seatHint)
  })

  it('offers each preset with what it is for', () => {
    renderSeat()

    fireEvent.click(screen.getByRole('button'))

    // The id alone never said what a preset does; the description is the
    // whole reason a preset can publish metadata at all.
    expect(screen.getByText(en.presetStandardDescription)).toBeTruthy()
    // A preset that published none still reads as a row, with its id standing
    // in for the name.
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    expect(screen.getByText('mine')).toBeTruthy()
  })

  it('falls back to the id when the staged preset published no name', () => {
    renderSeat({ current: 'mine' })

    expect(screen.getByRole('button').textContent).toContain('mine')
  })

  it('shows the staged id until a stale roster contains it', () => {
    renderSeat({ current: 'arriving' })

    expect(screen.getByRole('button').textContent).toContain('arriving')
  })

  it('stages the picked preset and closes the menu', () => {
    const actions = renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.click(screen.getByText('mine'))

    expect(actions.select).toHaveBeenCalledWith('mine')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('disables the trigger while a switch is in flight', () => {
    renderSeat({ busy: true })

    expect(screen.getByRole('button')).toHaveProperty('disabled', true)
  })

  it('shows a refused switch on the trigger', () => {
    renderSeat({ error: 'session has already started' })

    expect(screen.getByRole('button').getAttribute('title')).toBe('session has already started')
  })

  it('renders nothing before the roster arrives or when there is none', () => {
    const empty = renderSeat({ options: [] })
    expect(empty).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()

    renderSeat({ current: '' })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('closes on an outside dismissal', () => {
    renderSeat()
    fireEvent.click(screen.getByRole('button'))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a refused switch', () => {
  it('announces the reason instead of letting the label snap back in silence', async () => {
    // The banner's own timer has to be a fake one from the start, or the
    // lifetime assertion below would wait out its real nine seconds.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const reason = 'failed to import loader entry live-on-mac (@deepseek-ai/dsh-also-gone)'
      renderSeat({}, () => Promise.resolve(reason))

      fireEvent.click(screen.getByRole('button'))
      fireEvent.click(screen.getByRole('menuitem', { name: /mine/ }))

      // The host refuses a mount discovery reported healthy, so this banner is
      // the only place the cause appears — the chip has already reverted and
      // the settings row shows the preset as fine.
      const banner = await screen.findByRole('alert')
      expect(banner.textContent).toContain(reason)
      expect(banner.textContent).toContain('mine')

      // Transient by design: it holds long enough to read a cause that names
      // packages, then leaves rather than sitting over the screen.
      act(() => { vi.advanceTimersByTime(9001) })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing when the switch lands', async () => {
    const actions = renderSeat()

    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('menuitem', { name: /mine/ }))

    await waitFor(() => { expect(actions.select).toHaveBeenCalledWith('mine') })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the chip introduce cue', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Character spans carry inline animation delays; nothing else does. */
  function delayedChars(): HTMLElement[] {
    return Array.from(screen.getByRole('button').querySelectorAll<HTMLElement>('[style]'))
  }

  it('reveals a long Latin name inside the shared window, then acknowledges', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', trust: 'user', name: 'CreatorMode' }],
      introduce: true,
    })

    // Eleven characters split the 200ms window into 20ms steps, where the
    // fixed 40ms tick would have doubled the run for a Latin name.
    const chars = delayedChars()
    expect(chars.map(span => span.textContent).join('')).toBe('CreatorMode')
    expect(chars[0]!.style.animationDelay).toBe('150ms')
    expect(chars[1]!.style.animationDelay).toBe('170ms')
    expect(chars[10]!.style.animationDelay).toBe('350ms')

    // 150 delay + 200 window + 400 fade: acknowledged only once the last
    // character has settled, and the label is plain text again after.
    act(() => { vi.advanceTimersByTime(749) })
    expect(actions.introduced).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('keeps the per-tick cap for a short CJK name', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    renderSeat({
      current: 'creator',
      options: [{ id: 'creator', trust: 'user', name: '创造模式' }],
      introduce: true,
    })

    // Four characters fit under the window, so the 40ms tick applies as-is.
    const chars = delayedChars()
    expect(chars).toHaveLength(4)
    expect(chars[1]!.style.animationDelay).toBe('190ms')
    expect(chars[3]!.style.animationDelay).toBe('270ms')
  })

  it('starts a one-character name with no stagger at all', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.useFakeTimers()
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', trust: 'user', name: 'C' }],
      introduce: true,
    })

    expect(delayedChars()[0]!.style.animationDelay).toBe('150ms')
    act(() => { vi.advanceTimersByTime(550) })
    expect(actions.introduced).toHaveBeenCalledTimes(1)
  })

  it('skips the run under reduced motion and acknowledges at once', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const actions = renderSeat({ introduce: true })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })

  it('acknowledges an empty staged name without arming a run', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const actions = renderSeat({
      current: 'creator',
      options: [{ id: 'creator', trust: 'user', name: '' }],
      introduce: true,
    })

    expect(actions.introduced).toHaveBeenCalledTimes(1)
    expect(delayedChars()).toHaveLength(0)
  })
})

describe('the session-header picker', () => {
  it('names the preset the session runs and opens the roster on click', async () => {
    const { load } = renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    })

    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    expect(screen.getByRole('button').textContent).toContain(en.presetStandardName)
    fireEvent.click(screen.getByRole('button'))

    // The control IS the switch: every roster row is offered right here.
    expect(screen.getByText(`mine · ${en.userTrust}`)).toBeTruthy()
  })

  it('commits the picked preset onto this session', () => {
    const { switchPreset } = renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    })
    fireEvent.click(screen.getByRole('button'))

    fireEvent.click(screen.getByText(`mine · ${en.userTrust}`))

    expect(switchPreset).toHaveBeenCalledWith('s1', 'mine')
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('reports a host refusal on the trigger', async () => {
    const { switchPreset, view } = renderLabel({
      blank: false,
      projectionValues: { agentPreset: 'standard' },
    })
    switchPreset.mockRejectedValue(new Error('session is running'))
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByText(`mine · ${en.userTrust}`))

    // The rejection surfaces where the hint lives: the trigger's tooltip.
    await waitFor(() => {
      expect(view.getByTitle('session is running')).toBeTruthy()
    })
  })

  it('falls back to Default for a session that never named a preset', () => {
    renderLabel({ blank: true })

    // Even an old host-composition session can adopt one: nothing about an
    // absent choice freezes it, so the picker still renders.
    expect(screen.getByRole('button').textContent).toContain(en.headerDefault)
  })

  it('renders nothing when the deployment composes no presets and none recorded', () => {
    const absent = renderLabel({ blank: true }, { options: [] })
    expect(absent.view.container.firstChild).toBeNull()
    cleanup()

    const unknown = renderLabel(undefined, { options: [] })
    expect(unknown.view.container.firstChild).toBeNull()
  })
})
