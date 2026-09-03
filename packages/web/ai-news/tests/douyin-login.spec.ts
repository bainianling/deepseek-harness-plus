/** Douyin login-state detection over a Playwright storageState file. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { douyinStateLoggedIn } from '../src/index.ts'

describe('douyinStateLoggedIn', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-news-douyin-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('detects a live session cookie', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({
      cookies: [
        { name: 'ttwid', value: 'x', domain: '.douyin.com' },
        { name: 'sessionid', value: 'abc123', domain: '.douyin.com' },
      ],
      origins: [],
    }), 'utf8')
    expect(douyinStateLoggedIn(path)).toBe(true)
  })

  it('rejects a state file without session cookies', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({
      cookies: [{ name: 'ttwid', value: 'x', domain: '.douyin.com' }],
      origins: [],
    }), 'utf8')
    expect(douyinStateLoggedIn(path)).toBe(false)
  })

  it('rejects empty session cookie values', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({
      cookies: [{ name: 'sessionid', value: '', domain: '.douyin.com' }],
    }), 'utf8')
    expect(douyinStateLoggedIn(path)).toBe(false)
  })

  it('rejects a missing or corrupt file', async () => {
    expect(douyinStateLoggedIn(join(dir, 'missing.json'))).toBe(false)
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{broken', 'utf8')
    expect(douyinStateLoggedIn(bad)).toBe(false)
  })
})
