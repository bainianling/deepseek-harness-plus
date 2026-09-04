/**
 * Fetch layer: direct global fetch plus a dependency-free HTTPS-over-HTTP
 * CONNECT tunnel for sources behind the configured proxy (X and the overseas
 * RSS feeds from networks that block them). All responses are buffered; every
 * crawl payload is small (<= ~1 MB).
 * @module @deepseek-ai/dsh-ai-news/http
 */

import { execFile } from 'node:child_process'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

/** Shared browser-ish user agent for every crawl request. */
export const CRAWL_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Buffered HTTP response shape shared by the direct and proxied paths. */
export interface HttpResponse {
  status: number
  header(name: string): string | undefined
  text(): string
  buffer(): Buffer
}

/** Options accepted by {@link smartFetch}. */
export interface FetchOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  /** Route this request through the proxy when one is available. */
  preferProxy?: boolean
  /** Follow up to this many redirects (default 3). */
  maxRedirects?: number
  signal?: AbortSignal
  /** HTTP method for the direct path (crawlers stay GET; the translator POSTs). */
  method?: 'GET' | 'POST'
  /** Request body for the direct path. */
  body?: string
}

/** One resolved proxy endpoint. */
export interface ProxyEndpoint {
  host: string
  port: number
}

function makeResponse(status: number, headers: Record<string, string | string[] | undefined>, body: Buffer): HttpResponse {
  return {
    status,
    header: (name) => {
      const value = headers[name.toLowerCase()]
      return Array.isArray(value) ? value[0] : value
    },
    text: () => body.toString('utf8'),
    buffer: () => body,
  }
}

/** Open one CONNECT tunnel through an HTTP proxy; resolves the raw TCP socket. */
function connectTunnel(proxy: ProxyEndpoint, targetHost: string, targetPort: number, timeoutMs: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect(proxy.port, proxy.host)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      rejectPromise(error)
    }
    const timer = setTimeout(() => { fail(new Error('ai-news: proxy CONNECT timeout')) }, timeoutMs)
    const onAbort = (): void => { fail(new Error('ai-news: aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${String(targetPort)} HTTP/1.1\r\nHost: ${targetHost}:${String(targetPort)}\r\n\r\n`)
    })
    let buffered = ''
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('latin1')
      const boundary = buffered.indexOf('\r\n\r\n')
      if (boundary < 0) {
        if (buffered.length > 16_384) fail(new Error('ai-news: proxy CONNECT response overflow'))
        return
      }
      socket.off('data', onData)
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const statusLine = buffered.slice(0, buffered.indexOf('\r\n'))
      if (!/\s200(\s|$)/u.test(statusLine)) {
        socket.destroy()
        rejectPromise(new Error(`ai-news: proxy CONNECT rejected (${statusLine})`))
        return
      }
      resolvePromise(socket)
    }
    socket.on('data', onData)
    socket.once('error', (error) => { fail(error) })
  })
}

/** One buffered HTTPS request through an established tunnel socket. */
function tunnelRequest(url: URL, tunnel: net.Socket, options: FetchOptions): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; location: string | undefined }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeoutMs = options.timeoutMs ?? 30_000
    const request = https.request({
      host: url.hostname,
      port: url.port === '' ? 443 : Number(url.port),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: options.headers ?? {},
      timeout: timeoutMs,
      createConnection: () => tls.connect({ socket: tunnel, servername: url.hostname }),
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks),
          location: response.headers.location,
        })
      })
      response.once('error', rejectPromise)
    })
    request.once('timeout', () => { request.destroy(new Error('ai-news: request timeout')) })
    request.once('error', rejectPromise)
    if (options.signal !== undefined) {
      const onAbort = (): void => { request.destroy(new Error('ai-news: aborted')) }
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    request.end()
  })
}

/** Fetch one HTTPS URL through an HTTP CONNECT proxy. */
export async function fetchViaProxy(urlText: string, proxy: ProxyEndpoint, options: FetchOptions = {}): Promise<HttpResponse> {
  let current = new URL(urlText)
  const maxRedirects = options.maxRedirects ?? 3
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (current.protocol !== 'https:') throw new Error(`ai-news: proxy tunnel supports https only, got ${current.protocol}`)
    const port = current.port === '' ? 443 : Number(current.port)
    const tunnel = await connectTunnel(proxy, current.hostname, port, options.timeoutMs ?? 30_000, options.signal)
    const outcome = await tunnelRequest(current, tunnel, options)
    if (outcome.status >= 300 && outcome.status < 400 && outcome.location !== undefined) {
      tunnel.destroy()
      current = new URL(outcome.location, current)
      continue
    }
    return makeResponse(outcome.status, outcome.headers, outcome.body)
  }
  throw new Error('ai-news: too many redirects through proxy')
}

/** Fetch one URL directly with the global fetch (buffered). */
export async function fetchDirect(urlText: string, options: FetchOptions = {}): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const signal = options.signal !== undefined
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  const init: RequestInit = { signal, redirect: 'follow' }
  if (options.headers !== undefined) init.headers = options.headers
  if (options.method !== undefined) init.method = options.method
  if (options.body !== undefined) init.body = options.body
  const response = await fetch(urlText, init)
  const body = Buffer.from(await response.arrayBuffer())
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
  return makeResponse(response.status, headers, body)
}

/**
 * Fetch with proxy fallback: `preferProxy` and an available proxy go through
 * the tunnel first with a direct fallback; otherwise direct-first with a
 * proxy fallback when one exists.
 */
export async function smartFetch(
  url: string,
  proxy: ProxyEndpoint | undefined,
  options: FetchOptions = {},
): Promise<HttpResponse> {
  if (proxy !== undefined && options.preferProxy === true) {
    try {
      return await fetchViaProxy(url, proxy, options)
    } catch {
      return fetchDirect(url, options)
    }
  }
  if (proxy === undefined) return fetchDirect(url, options)
  try {
    return await fetchDirect(url, options)
  } catch (error) {
    try {
      return await fetchViaProxy(url, proxy, options)
    } catch {
      throw error
    }
  }
}

/** Parse an `http://host:port` proxy literal; undefined when unusable. */
export function parseProxy(value: string): ProxyEndpoint | undefined {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return undefined
    const port = url.port === '' ? (url.protocol === 'http:' ? 80 : 443) : Number(url.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
    return { host: url.hostname, port }
  } catch {
    return undefined
  }
}

/**
 * Auto-detect the Windows system (WinINET) HTTP proxy from the registry.
 * Non-win32 platforms and missing/disabled settings resolve undefined.
 */
export function detectSystemProxy(): Promise<ProxyEndpoint | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined)
  return new Promise((resolvePromise) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error !== null) {
        resolvePromise(undefined)
        return
      }
      const match = /ProxyServer\s+REG_SZ\s+(\S+)/u.exec(stdout)
      if (match === null) {
        resolvePromise(undefined)
        return
      }
      const raw = match[1] ?? ''
      const literal = raw.includes('://') ? raw : `http://${raw}`
      resolvePromise(parseProxy(literal))
    })
  })
}
