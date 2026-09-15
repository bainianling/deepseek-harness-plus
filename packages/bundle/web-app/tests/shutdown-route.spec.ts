/**
 * The /server/shutdown control route: local-control fencing (method, source
 * address, same-origin), the missing-exit-service arm, and the graceful exit
 * request that fires only after the ack is flushed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AppExit } from '@deepseek-ai/dsh-cmdline'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, internals } from '../src/index.ts'

let dist: string | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  internals.resolveDistIndex = originalResolve
  if (dist !== undefined) rmSync(dist, { recursive: true, force: true })
  dist = undefined
})

const originalResolve = internals.resolveDistIndex

/** Stage a dist fixture so FrontendStatic mounts without a built workspace. */
function stageDist(): void {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-app-shutdown-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  internals.resolveDistIndex = () => index
}

interface FakeServer {
  server: WebServer
  route: () => WebRoute | undefined
}

/** A fake webServer capturing exactly one named-route registration. */
function fakeHttpServer(): FakeServer {
  let registered: WebRoute | undefined
  const server = {
    host: '0.0.0.0',
    port: 3080,
    guard: () => () => {},
    register: (route: WebRoute) => {
      registered = route
      return () => {}
    },
    registerFallback: () => () => {},
    renderIndex: (html: string) => html,
  } as unknown as WebServer
  return { server, route: () => registered }
}

/** A request whose socket address and Origin header the test controls. */
function fakeReq(method: string, remoteAddress = '127.0.0.1', origin?: string, host?: string): IncomingMessage {
  return {
    method,
    headers: {
      ...(origin === undefined ? {} : { origin }),
      ...(host === undefined ? {} : { host }),
    },
    socket: { remoteAddress },
  } as unknown as IncomingMessage
}

interface RecordedResponse {
  status: number
  body: string
}

function fakeRes(): ServerResponse & RecordedResponse {
  const res: {
    status: number
    body: string
    headersSent: boolean
    writeHead(code: number): unknown
    end(body?: string): unknown
  } = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(code) {
      res.status = code
      res.headersSent = true
      return res
    },
    end(body) {
      res.body += body ?? ''
      return res
    },
  }
  return res as unknown as ServerResponse & RecordedResponse
}

describe('the /server/shutdown control route', () => {
  function mount(appExit: AppExit | undefined): { handler: NonNullable<ReturnType<FakeServer['route']>>['handler'] } {
    stageDist()
    const { server, route } = fakeHttpServer()
    const ctx = new Context()
    ctx.provide('webServer', server)
    if (appExit !== undefined) ctx.provide('appExit', appExit)
    apply(ctx, { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [], hindsightUrl: 'http://127.0.0.1:9077', hindsightBankId: 'coding-agent::deepseek-harness', knowledgeTimeoutMs: 5000, hindsightProfile: 'dsh-local', hindsightCommand: 'hindsight-embed', hindsightStartTimeoutMs: 30_000 })
    const registered = route()
    if (registered === undefined) throw new Error('shutdown route not registered')
    return { handler: registered.handler }
  }

  it('answers a loopback POST with the ack and exits gracefully behind it', async () => {
    const exit = vi.fn()
    const { handler } = mount(exit as unknown as AppExit)
    const res = fakeRes()

    await handler(fakeReq('POST'), res)

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('accepts bracketed IPv6 loopback when Host and Origin match', async () => {
    const exit = vi.fn()
    const { handler } = mount(exit as unknown as AppExit)
    const res = fakeRes()

    await handler(fakeReq('POST', '::1', 'http://[::1]:3080', '[::1]:3080'), res)

    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    vi.advanceTimersByTime(200)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('rejects non-POST methods and off-loopback sources', async () => {
    const exit = vi.fn()
    const { handler } = mount(exit as unknown as AppExit)

    for (const [req] of [
      [fakeReq('GET')],
      [fakeReq('DELETE')],
      [fakeReq('POST', '192.168.1.5')],
      [fakeReq('POST', '::ffff:192.168.1.5')],
      // Cross-origin browser requests are fenced like the other controls.
      [fakeReq('POST', '127.0.0.1', 'http://evil.example')],
      [fakeReq('POST', '::1', 'http://[::1]:3080', '[::1]:3081')],
    ] as const) {
      const res = fakeRes()
      await handler(req, res)
      expect(res.status).toBe(403)
    }

    vi.advanceTimersByTime(1000)
    expect(exit).not.toHaveBeenCalled()
  })

  it('reports unavailability when the launcher provided no exit service', async () => {
    const { handler } = mount(undefined)
    const res = fakeRes()

    await handler(fakeReq('POST'), res)

    expect(res.status).toBe(503)
  })
})
