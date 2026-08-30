/**
 * Bilibili WBI request signing (the public web search API). The mixin key is
 * the two rotating key filenames interleaved through a fixed 64-entry table
 * and truncated to 32 chars; `w_rid` is the md5 of the sorted query string
 * plus that mixin key. Keys rotate periodically, so callers fetch them fresh
 * from `/x/web-interface/nav` per crawl.
 * @module @deepseek-ai/dsh-ai-news/wbi
 */

import { createHash } from 'node:crypto'

/** The fixed interleaving table (indices into the concatenated key pair). */
export const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

/** Derive the 32-char mixin key from the img/sub key pair. */
export function mixinKeyOf(imgKey: string, subKey: string): string {
  const joined = imgKey + subKey
  let out = ''
  for (const index of MIXIN_KEY_ENC_TAB) {
    const char = joined[index]
    if (char !== undefined) out += char
    if (out.length >= 32) break
  }
  return out.slice(0, 32)
}

/** Extract the key name from a wbi icon URL (`https://.../<key>.png`). */
export function keyFromIconUrl(url: string): string {
  const tail = url.slice(url.lastIndexOf('/') + 1)
  return tail.split('.')[0] ?? ''
}

/**
 * Sign one parameter set: adds the `wts` timestamp, sorts keys, appends
 * `w_rid`. Values are URL-encoded in the canonical query form.
 * @param params - query parameters without wts/w_rid.
 * @param imgKey - current img key from the nav endpoint.
 * @param subKey - current sub key from the nav endpoint.
 * @param nowSeconds - timestamp override (tests pin this).
 * @returns the complete signed query string.
 */
export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const full: Record<string, string | number> = { ...params, wts: nowSeconds }
  const query = Object.keys(full).sort()
    .map(key => `${key}=${encodeURIComponent(String(full[key]))}`)
    .join('&')
  const mixin = mixinKeyOf(imgKey, subKey)
  const wRid = createHash('md5').update(query + mixin).digest('hex')
  return `${query}&w_rid=${wRid}`
}
