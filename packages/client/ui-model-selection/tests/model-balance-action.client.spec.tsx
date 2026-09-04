// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelBalanceAction } from '../src/client/ModelBalanceAction.tsx'
import { zh } from '../src/client/locales.ts'

const state = (overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState => ({
  current: { provider: 'pptoken', model: 'gpt-5.6-terra' },
  routable: true,
  groups: [{
    id: 'pptoken',
    name: 'PPToken',
    models: [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' }],
  }],
  failures: [],
  status: 'ready',
  error: null,
  ...overrides,
})

const t: ComponentProps<typeof ModelBalanceAction>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function renderAction(directory: ReturnType<typeof createSnapshotStore<ModelDirectoryState>>) {
  const directoryFor = vi.fn(() => ({
    store: directory,
    load: vi.fn().mockResolvedValue(undefined),
  }))
  const useSessions = ((selector: (value: { current: string }) => unknown) => selector({ current: 'session-1' })) as never
  const useWorkspaces = ((selector: (value: { current: string[] }) => unknown) => selector({ current: [] })) as never
  const useSessionPendingInteraction = ((selector: (value: unknown) => unknown) => selector(undefined)) as never
  return render(<ModelBalanceAction
    wide
    useSessions={useSessions}
    useWorkspaces={useWorkspaces}
    useSessionPendingInteraction={useSessionPendingInteraction}
    directoryFor={directoryFor as never}
    t={t}
  />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ModelBalanceAction', () => {
  it('identifies the current third-party model and does not request a guessed balance endpoint', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    renderAction(createSnapshotStore(state()))

    expect(screen.getByText('GPT-5.6 Terra')).toBeTruthy()
    expect(screen.getByText('余额请在提供方控制台查看')).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('renders the existing wallet snapshot only for the DeepSeek official route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balance: { available: true, total: 42.5, currency: 'CNY' } }),
    }))
    renderAction(createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
      }],
    })))

    await waitFor(() => {
      expect(screen.getByText('余额 ¥42.50')).toBeTruthy()
    })
  })
})
