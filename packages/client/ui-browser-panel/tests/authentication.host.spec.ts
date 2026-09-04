/** Authentication handoff for the independent built-in browser context. */

import { describe, expect, it, vi } from 'vitest'
import { internals } from '../src/index.ts'

interface BrowserPageState {
  readonly url: string
  readonly title: string
  readonly screenshotPath?: string
}

function fixtureBrowser(): {
  readonly open: ReturnType<typeof vi.fn<(url: string) => Promise<BrowserPageState>>>
  readonly read: () => Promise<BrowserPageState>
  readonly status: () => Promise<{ enabled: boolean; headless: boolean }>
} {
  return {
    open: vi.fn(async (url: string) => ({ url, title: url })),
    read: async () => ({ url: 'about:blank', title: '' }),
    status: async () => ({ enabled: true, headless: true }),
  }
}

function fixtureConnection(): {
  readonly authenticatedUrl: ReturnType<typeof vi.fn<(baseUrl: string) => string>>
  readonly rpc: { readonly handle: () => () => void }
} {
  return {
    authenticatedUrl: vi.fn((baseUrl: string) => `${baseUrl}/?token=real-process-token`),
    rpc: { handle: () => () => undefined },
  }
}

describe('built-in browser authentication handoff', () => {
  it.each([
    'http://127.0.0.1:3080/',
    'http://127.12.34.56:3080/news?filter=ai#today',
    'http://localhost:3080/work',
    'http://[::1]:3080/settings',
  ])('bootstraps an official cookie before opening DSH URL %s', async (targetUrl) => {
    const browser = fixtureBrowser()
    const connection = fixtureConnection()
    const target = new URL(targetUrl)

    const state = await internals.openWithHarnessAuth(browser.open, connection, target, 3080)

    expect(connection.authenticatedUrl).toHaveBeenCalledOnce()
    expect(connection.authenticatedUrl).toHaveBeenCalledWith(target.origin)
    expect(browser.open).toHaveBeenNthCalledWith(1, `${target.origin}/?token=real-process-token`)
    expect(browser.open).toHaveBeenNthCalledWith(2, target.href)
    expect(state.url).toBe(target.href)
    expect(state.url).not.toContain('token=')
  })

  it('removes only the authentication handoff screenshot', async () => {
    const open = vi.fn<(url: string) => Promise<BrowserPageState>>()
      .mockResolvedValueOnce({
        url: 'http://127.0.0.1:3080/',
        title: 'DSH',
        screenshotPath: 'C:\\snapshots\\auth.png',
      })
      .mockResolvedValueOnce({
        url: 'http://127.0.0.1:3080/news',
        title: 'News',
        screenshotPath: 'C:\\snapshots\\news.png',
      })
    const connection = fixtureConnection()
    const remove = vi.fn<(filePath: string) => void>()

    const state = await internals.openWithHarnessAuth(
      open,
      connection,
      new URL('http://127.0.0.1:3080/news'),
      3080,
      undefined,
      remove,
    )

    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('C:\\snapshots\\auth.png')
    expect(state.screenshotPath).toBe('C:\\snapshots\\news.png')
  })

  it.each([
    'https://127.0.0.1:3080/',
    'http://127.0.0.1:3081/',
    'http://192.168.1.20:3080/',
    'https://example.com/article',
  ])('never exposes the authentication bootstrap to non-DSH URL %s', async (targetUrl) => {
    const browser = fixtureBrowser()
    const connection = fixtureConnection()
    const target = new URL(targetUrl)

    const state = await internals.openWithHarnessAuth(browser.open, connection, target, 3080)

    expect(connection.authenticatedUrl).not.toHaveBeenCalled()
    expect(browser.open).toHaveBeenCalledOnce()
    expect(browser.open).toHaveBeenCalledWith(target.href)
    expect(state.url).toBe(target.href)
  })

  it('does not authenticate when the active Web server port is unavailable', async () => {
    const browser = fixtureBrowser()
    const connection = fixtureConnection()
    const target = new URL('http://127.0.0.1:3080/')

    await internals.openWithHarnessAuth(browser.open, connection, target, undefined)

    expect(connection.authenticatedUrl).not.toHaveBeenCalled()
    expect(browser.open).toHaveBeenCalledOnce()
  })
})
