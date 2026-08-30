// @vitest-environment jsdom
/**
 * JailbreakChip over the `jailbreak` projection: nothing renders while the
 * capability is absent or the effective target is the default mode; while
 * jailbreak mode is the target, the chip executes /jailbreak off and remains
 * visible through failures until the projection confirms the exit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { JailbreakProjection } from '@deepseek-ai/dsh-jailbreak-mode/client'
import { JailbreakChip, type JailbreakChipProps } from '../src/client/JailbreakChip.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t: JailbreakChipProps['t'] = makeTranslate(zh, commonZh)

function setup(
  jailbreak: JailbreakProjection | undefined,
  exitJailbreakMode = vi.fn(() => Promise.resolve<string | null>(null)),
  locked = false,
) {
  const store = createSnapshotStore<{ value: JailbreakProjection | undefined }>({ value: jailbreak })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = { useProjection, locked, exitJailbreakMode, t } as unknown as JailbreakChipProps
  const view = render(<JailbreakChip {...props} />)
  return { store, exitJailbreakMode, view }
}

const chip = () => screen.getByRole('button', { name: '破甲模式已开启，按下关闭' })

describe('JailbreakChip', () => {
  it('renders nothing for an absent capability or a default-mode target', () => {
    const absent = setup(undefined)
    expect(absent.view.container.innerHTML).toBe('')
    cleanup()
    const inactive = setup({ active: false, pending: false, strategy: 'dan' })
    expect(inactive.view.container.innerHTML).toBe('')
    cleanup()
    const leaving = setup({ active: true, pending: true, strategy: 'dan' })
    expect(leaving.view.container.innerHTML).toBe('')
  })

  it('renders the JB status for active and pending-entry targets', () => {
    setup({ active: true, pending: false, strategy: 'dan' })
    expect(chip().textContent).toBe('JB')
    cleanup()
    setup({ active: false, pending: true, strategy: 'dan' })
    expect(chip().textContent).toBe('JB')
  })

  it('executes /jailbreak off once and follows the projection down', async () => {
    let resolve!: (value: string | null) => void
    const exitJailbreakMode = vi.fn(() => new Promise<string | null>((done) => { resolve = done }))
    const { store } = setup({ active: true, pending: false, strategy: 'dan' }, exitJailbreakMode)
    fireEvent.click(chip())
    expect(exitJailbreakMode).toHaveBeenCalledTimes(1)
    fireEvent.click(chip())
    expect(exitJailbreakMode).toHaveBeenCalledTimes(1)
    resolve(null)
    store.set({ value: { active: true, pending: true, strategy: 'dan' } })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '破甲模式已开启，按下关闭' })).toBeNull()
    })
  })

  it('disables under the locked owner prop', () => {
    setup({ active: true, pending: false, strategy: 'dan' }, vi.fn(), true)
    expect((chip() as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces admission and transport failures while staying visible', async () => {
    const exitJailbreakMode = vi.fn()
      .mockResolvedValueOnce('host said no')
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce('socket closed')
    setup({ active: true, pending: false, strategy: 'dan' }, exitJailbreakMode)
    fireEvent.click(chip())
    expect((await screen.findByText('failed to exit jailbreak mode')).getAttribute('title')).toBe('host said no')
    expect(chip()).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('network down')).toBeTruthy()

    fireEvent.click(chip())
    expect(await screen.findByTitle('socket closed')).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const successful = setup(
      { active: true, pending: false, strategy: 'dan' },
      vi.fn(() => new Promise<string | null>((done) => { resolve = done })),
    )
    fireEvent.click(chip())
    successful.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const exitJailbreakMode = vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail }))
    const { view } = setup({ active: true, pending: false, strategy: 'dan' }, exitJailbreakMode)
    fireEvent.click(chip())
    view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})
