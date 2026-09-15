// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import type { PromptEnhancerProps } from '../src/client/PromptEnhancer.tsx'
import { PromptEnhancer } from '../src/client/PromptEnhancer.tsx'
import { zh } from '../src/client/locales.ts'

const t: ComponentProps<typeof PromptEnhancer>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

const sessionId = 'session-1' as PromptEnhancerProps['sessionId']

const session = {
  removed: false,
}

const idleInput = {
  draft: '',
  attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [],
}

/** Mutable test prop bag: individual cases swap fakes without readonly errors. */
function baseProps(): Record<string, unknown> {
  return {
    available: true,
    sessionId,
    useSession: (selector: (state: typeof session) => unknown) => selector(session),
    useInput: (selector: (state: typeof idleInput) => unknown) => selector(idleInput),
    inputActions: { setDraft: () => {} },
    directory: createSnapshotStore(state()),
    enhance: vi.fn().mockResolvedValue({ ok: true, value: { prompt: 'enhanced' } }),
    t,
  }
}

function renderWith(props: Record<string, unknown>, input: typeof idleInput = idleInput): void {
  const merged = { ...props, useInput: (selector: (state: typeof idleInput) => unknown) => selector(input) }
  render(<PromptEnhancer {...(merged as unknown as ComponentProps<typeof PromptEnhancer>)} />)
}

afterEach(cleanup)

describe('PromptEnhancer', () => {
  it('renders nothing for an addressed subagent session', () => {
    renderWith({ ...baseProps(), available: false })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the panel, reads the toggle, and submits the exact current selection', async () => {
    const setDraft = vi.fn()
    const enhance = vi.fn().mockResolvedValue({ ok: true, value: { prompt: 'better prompt' } })
    renderWith({
      ...baseProps(),
      inputActions: { setDraft },
      enhance,
    }, {
      ...idleInput,
      draft: 'make it fast',
    })

    fireEvent.click(screen.getByRole('button', { name: '丰富提示词' }))
    fireEvent.click(screen.getByRole('switch', { name: '先阅读项目再丰富' }))
    fireEvent.click(screen.getByRole('button', { name: '开始丰富' }))

    await waitFor(() => {
      expect(enhance).toHaveBeenCalledWith({
        sessionId,
        prompt: 'make it fast',
        readProject: true,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      })
    })
    await waitFor(() => {
      expect(setDraft).toHaveBeenCalledWith('better prompt')
    })
    // The original draft is now revertible from the panel.
    expect(screen.getByRole('button', { name: '还原原始提示词' })).toBeTruthy()
  })

  it('reverts the draft back to the pre-enhancement text', async () => {
    const setDraft = vi.fn()
    renderWith({
      ...baseProps(),
      inputActions: { setDraft },
    }, {
      ...idleInput,
      draft: 'original text',
    })

    fireEvent.click(screen.getByRole('button', { name: '丰富提示词' }))
    fireEvent.click(screen.getByRole('button', { name: '开始丰富' }))
    await waitFor(() => expect(setDraft).toHaveBeenCalledWith('enhanced'))

    fireEvent.click(screen.getByRole('button', { name: '还原原始提示词' }))
    expect(setDraft).toHaveBeenLastCalledWith('original text')
    // One-step revert: the revert affordance disappears after use.
    expect(screen.queryByRole('button', { name: '还原原始提示词' })).toBeNull()
  })

  it('shows the empty-draft error without calling the host', () => {
    const enhance = vi.fn()
    renderWith({
      ...baseProps(),
      enhance,
    }, {
      ...idleInput,
      draft: '   ',
    })

    fireEvent.click(screen.getByRole('button', { name: '丰富提示词' }))
    fireEvent.click(screen.getByRole('button', { name: '开始丰富' }))
    expect(screen.getByRole('alert').textContent).toContain('请先输入要丰富的提示词')
    expect(enhance).not.toHaveBeenCalled()
  })

  it('announces a host rejection through the panel error strip', async () => {
    renderWith({
      ...baseProps(),
      enhance: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'session/prompt-enhancement-invalid', message: 'the selected model changed', details: { reason: 'STALE_MODEL' } },
      }),
    }, {
      ...idleInput,
      draft: 'make it fast',
    })

    fireEvent.click(screen.getByRole('button', { name: '丰富提示词' }))
    fireEvent.click(screen.getByRole('button', { name: '开始丰富' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the selected model changed')
    expect(alert.textContent).toContain('session/prompt-enhancement-invalid')
  })

  it('keeps the trigger disabled without a selected model', () => {
    renderWith({
      ...baseProps(),
      directory: createSnapshotStore(state({ current: null })),
    }, {
      ...idleInput,
      draft: 'make it fast',
    })

    const trigger = screen.getByRole('button', { name: '丰富提示词' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    // No panel can open from a disabled trigger.
    expect(screen.queryByRole('button', { name: '开始丰富' })).toBeNull()
  })
})
