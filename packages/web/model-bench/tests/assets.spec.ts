/** Seed-image PNG encoder: validity, determinism, and maintenance. */

import { readFile, readdir, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureSeedImages, encodePng, hasPngSignature, readPngDimensions, renderSeedScene, SEED_IMAGE_SIZE } from '../src/assets.ts'

describe('renderSeedScene + encodePng', () => {
  it('emits a valid PNG at the seed image size', () => {
    const scene = renderSeedScene(42)
    expect(hasPngSignature(scene.png)).toBe(true)
    expect(scene.width).toBe(SEED_IMAGE_SIZE)
    expect(scene.height).toBe(SEED_IMAGE_SIZE)
    expect(readPngDimensions(scene.png)).toEqual({ width: SEED_IMAGE_SIZE, height: SEED_IMAGE_SIZE })
    expect(scene.shapes.length).toBeGreaterThanOrEqual(4)
    expect(scene.shapes.length).toBeLessThanOrEqual(7)
  })

  it('is deterministic per seed and distinct across seeds', () => {
    const a1 = renderSeedScene(7)
    const a2 = renderSeedScene(7)
    const b = renderSeedScene(8)
    expect(Buffer.from(a1.png).equals(Buffer.from(a2.png))).toBe(true)
    expect(Buffer.from(a1.png).equals(Buffer.from(b.png))).toBe(false)
    expect(a1.shapes).toEqual(a2.shapes)
  })

  it('rejects raster size mismatches', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow('raster size mismatch')
  })
})

describe('readPngDimensions', () => {
  it('returns null for non-PNG bytes', () => {
    expect(readPngDimensions(Uint8Array.of(1, 2, 3))).toBeNull()
    expect(readPngDimensions(new Uint8Array(0))).toBeNull()
  })
})

describe('ensureSeedImages', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'model-bench-assets-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the full seed set once and keeps it on repeat calls', async () => {
    const names = await ensureSeedImages(dir, 4)
    expect(names).toEqual(['vision-v1.png', 'vision-v2.png', 'vision-v3.png', 'vision-v4.png'])
    const onDisk = (await readdir(dir)).sort()
    expect(onDisk).toEqual(names)
    const bytes = await readFile(join(dir, names[0]!))
    expect(hasPngSignature(new Uint8Array(bytes))).toBe(true)
    // A second call must not rewrite or duplicate anything.
    await ensureSeedImages(dir, 4)
    expect((await readdir(dir)).sort()).toEqual(names)
  })
})
