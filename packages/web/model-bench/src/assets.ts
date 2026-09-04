/**
 * Deterministic seed images for the vision (image-recognition) category. A
 * minimal dependency-free PNG encoder (node:zlib deflate + hand-rolled CRC32)
 * draws seeded synthetic scenes — colored circles, rectangles, and triangles
 * on a plain background — so vision rounds always have viewable material
 * without shipping binary assets. Every round's generator agent looks at one
 * image with its own read_image tool before writing the question.
 * @module @deepseek-ai/dsh-model-bench/assets
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

/** Seed image edge length in pixels. */
export const SEED_IMAGE_SIZE = 256
/** File name prefix marking bench-owned seed images. */
export const SEED_IMAGE_PREFIX = 'vision-v'

/** Standard PNG file signature. */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

/** One generated shape's record (kept for tests and the manifest). */
export interface SeedShape {
  readonly kind: 'circle' | 'rect' | 'triangle'
  readonly color: [number, number, number]
  readonly cx: number
  readonly cy: number
  readonly size: number
}

/** One rendered seed scene. */
export interface SeedScene {
  readonly seed: number
  readonly width: number
  readonly height: number
  readonly background: [number, number, number]
  readonly shapes: readonly SeedShape[]
  readonly png: Uint8Array
}

/** Precomputed CRC32 table (PNG chunk checksums). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32 over one byte range. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Assemble one PNG chunk (length + type + data + crc). */
function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map(char => char.charCodeAt(0)))
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const chunk = new Uint8Array(4 + body.length + 4)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(body, 4)
  view.setUint32(4 + body.length, crc32(body))
  return chunk
}

/**
 * Encode one RGBA raster as a PNG file buffer (8-bit RGBA, no interlace,
 * filter type 0 on every scanline).
 * @param width - raster width in pixels.
 * @param height - raster height in pixels.
 * @param rgba - row-major RGBA bytes (width * height * 4 long).
 * @returns the complete PNG file content.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error('raster size mismatch')
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // Filter every scanline with type 0 (None).
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (1 + width * 4)
    raw[rawOffset] = 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rawOffset + 1)
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)))
  const parts = [PNG_SIGNATURE, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Deterministic PRNG (mulberry32) for reproducible scenes. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Whether one pixel falls inside one shape. */
function inShape(shape: SeedShape, x: number, y: number): boolean {
  if (shape.kind === 'circle') {
    const dx = x - shape.cx
    const dy = y - shape.cy
    return dx * dx + dy * dy <= shape.size * shape.size
  }
  if (shape.kind === 'rect') {
    const half = shape.size
    return x >= shape.cx - half && x < shape.cx + half && y >= shape.cy - half && y < shape.cy + half
  }
  // Triangle: isoceles apex above the centroid, base twice the size.
  const ax = shape.cx
  const ay = shape.cy - shape.size
  const bx = shape.cx - shape.size
  const by = shape.cy + shape.size
  const cx = shape.cx + shape.size
  const cy = shape.cy + shape.size
  const sign = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number =>
    (px - rx) * (qy - ry) - (qx - rx) * (py - ry)
  const d1 = sign(x, y, ax, ay, bx, by)
  const d2 = sign(x, y, bx, by, cx, cy)
  const d3 = sign(x, y, cx, cy, ax, ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/** Distinct saturated palette entries (RGB). */
const PALETTE: readonly [number, number, number][] = [
  [227, 63, 63], // red
  [63, 127, 227], // blue
  [63, 187, 95], // green
  [237, 187, 51], // yellow
  [171, 79, 209], // purple
  [237, 127, 51], // orange
  [51, 197, 207], // cyan
  [239, 117, 167], // pink
]

/**
 * Render one deterministic scene for a numeric seed.
 * @param seed - 32-bit scene seed (same seed → identical PNG bytes).
 * @param size - square edge length in pixels.
 * @returns the scene with its PNG bytes and shape manifest.
 */
export function renderSeedScene(seed: number, size: number = SEED_IMAGE_SIZE): SeedScene {
  const rand = mulberry32(seed)
  const background: [number, number, number] = [245, 245, 245]
  const shapeCount = 4 + Math.floor(rand() * 4) // 4–7 shapes
  const kinds: SeedShape['kind'][] = ['circle', 'rect', 'triangle']
  const shapes: SeedShape[] = []
  for (let i = 0; i < shapeCount; i += 1) {
    const color = PALETTE[Math.floor(rand() * PALETTE.length)] ?? [120, 120, 120]
    shapes.push({
      kind: kinds[Math.floor(rand() * kinds.length)] ?? 'circle',
      color,
      cx: Math.floor(size * 0.15 + rand() * size * 0.7),
      cy: Math.floor(size * 0.15 + rand() * size * 0.7),
      size: Math.floor(size * 0.08 + rand() * size * 0.14),
    })
  }
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let [r, g, b] = background
      // Later shapes paint over earlier ones.
      for (const shape of shapes) {
        if (!inShape(shape, x, y)) continue
        ;[r, g, b] = shape.color
      }
      const offset = (y * size + x) * 4
      rgba[offset] = r
      rgba[offset + 1] = g
      rgba[offset + 2] = b
      rgba[offset + 3] = 255
    }
  }
  return { seed, width: size, height: size, background, shapes, png: encodePng(size, size, rgba) }
}

/**
 * Ensure the seed image set exists under one assets directory. Existing
 * bench-owned images are kept; the directory is created when missing.
 * @param assetsDir - absolute image directory.
 * @param count - number of seed images maintained.
 * @returns the maintained image file names (sorted).
 */
export async function ensureSeedImages(assetsDir: string, count = 8): Promise<string[]> {
  await mkdir(assetsDir, { recursive: true })
  const existing = new Set((await readdir(assetsDir).catch(() => [] as string[]))
    .filter(name => name.startsWith(SEED_IMAGE_PREFIX) && name.endsWith('.png')))
  const names: string[] = []
  for (let i = 1; i <= count; i += 1) {
    const name = `${SEED_IMAGE_PREFIX}${String(i)}.png`
    names.push(name)
    if (existing.has(name)) continue
    const scene = renderSeedScene(0xb3e4c4_00 + i * 7919)
    const target = join(assetsDir, name)
    const tmp = join(assetsDir, `.${name}.${randomUUID().slice(0, 8)}.tmp`)
    await writeFile(tmp, Buffer.from(scene.png))
    await rename(tmp, target)
  }
  return names
}

/** Whether one file looks like a PNG by its signature bytes. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false
  }
  return true
}

/**
 * Read one PNG's IHDR dimensions (tiny parser for tests and diagnostics).
 * @param bytes - complete PNG file content.
 * @returns width and height, or null when the bytes are not a PNG.
 */
export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!hasPngSignature(bytes)) return null
  // IHDR must be the first chunk: 4-byte length at offset 8, then "IHDR".
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 + 4 + 4 + 8) return null
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0)
  if (type !== 'IHDR') return null
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Whether a directory entry is a bench-owned seed image. */
export function isSeedImageName(name: string): boolean {
  return name.startsWith(SEED_IMAGE_PREFIX) && name.endsWith('.png')
}

/** Seed image maintenance is best-effort; stat keeps callers honest. */
export async function seedImageExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
