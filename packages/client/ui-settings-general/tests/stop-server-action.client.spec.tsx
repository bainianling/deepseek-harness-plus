// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StopServerActionProps } from '../src/client/StopServerAction.tsx'
import { StopServerAction } from '../src/client/StopServerAction.tsx'
import { zh, type SettingsKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mount(wide = true): void {
  const t = ((key: SettingsKey) => zh[key]) as StopServerActionProps['t']
  const unusedHook = (() => { throw new Error('unused by StopServerAction') }) as never
  const props = {
    wide,
    t,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
  } as StopServerActionProps
  render(<StopServerAction {...props} />)
}

describe('StopServerAction', () => {
  it('renders the wide row label and the rail icon-only variant', () => {
    mount(true)
    const button = screen.getByRole('button', { name: '停止服务' })
    expect(button.textContent).toContain('停止服务')

    cleanup()
    mount(false)
    // The rail keeps the accessible name but paints no visible copy.
    expect(screen.getByRole('button', { name: '停止服务' }).textContent).toBe('')
  })

  it('arms on the first click and sends the shutdown POST on the second', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    mount(true)

    fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '停止服务' }).textContent).toContain(zh['stopServer.confirm'])

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    })
    expect(fetchMock).toHaveBeenCalledWith('/server/shutdown', expect.objectContaining({ method: 'POST' }))
    // Acked request holds the stopping state instead of restoring the control.
    expect(screen.getByRole('button', { name: '停止服务' }).textContent).toContain(zh['stopServer.stopping'])
    expect((screen.getByRole('button', { name: '停止服务' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('returns to idle when the confirm window lapses without a second click', () => {
    vi.useFakeTimers()
    mount(true)

    fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    expect(screen.getByRole('button', { name: '停止服务' }).textContent).toContain(zh['stopServer.confirm'])

    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.getByRole('button', { name: '停止服务' }).textContent).toContain(zh['stopServer'])
  })

  it('restores the control when the shutdown request fails', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('forbidden', { status: 403 })))
    vi.stubGlobal('fetch', fetchMock)
    mount(true)

    fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A failed request re-arms nothing: the row is idle again.
    expect(screen.getByRole('button', { name: '停止服务' }).textContent).toContain(zh['stopServer'])
    expect((screen.getByRole('button', { name: '停止服务' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
