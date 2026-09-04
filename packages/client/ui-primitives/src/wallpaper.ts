/**
 * Wallpaper store: a framework-free external store plus IndexedDB persistence
 * for a user-imported full-screen wallpaper (static image or dynamic video).
 * The media is kept as a Blob in IndexedDB so the choice survives refresh and
 * server restarts without bloating localStorage; at boot it is rehydrated into
 * an object URL. The active wallpaper toggles `body[data-dsh-wallpaper]` so the
 * theme sheets can make the app surfaces translucent and let the media show
 * through the whole interface.
 */

/** One applied wallpaper as renderable by {@link WallpaperLayer}. */
export interface WallpaperView {
  /** Media kind decides <img> vs <video>. */
  kind: 'image' | 'video'
  /** Object URL of the stored Blob. */
  url: string
  /** Original file name (for the picker UI). */
  name: string
}

type Listener = () => void

let current: WallpaperView | undefined
let objectUrl: string | undefined
const listeners = new Set<Listener>()

const DB_NAME = 'dsh-wallpaper'
const STORE = 'current'
const KEY = 'wallpaper'

/** Body attribute that reveals the wallpaper and translucent surfaces. */
export const WALLPAPER_BODY_ATTR = 'data-dsh-wallpaper'

function emit(): void {
  for (const listener of listeners) listener()
}

/** Current applied wallpaper (undefined when none). Stable between changes. */
export function getWallpaper(): WallpaperView | undefined {
  return current
}

/** Subscribe to wallpaper changes; returns an unsubscriber. */
export function subscribeWallpaper(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
  })
}

interface StoredRecord {
  kind: 'image' | 'video'
  type: string
  name: string
  blob: Blob
}

function idbSet(record: StoredRecord | undefined): Promise<void> {
  return openDb().then(db => new Promise<void>((resolve) => {
    if (db === undefined) { resolve(); return }
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    if (record === undefined) store.delete(KEY)
    else store.put(record, KEY)
    tx.oncomplete = () => { resolve() }
    tx.onerror = () => { resolve() }
    tx.onabort = () => { resolve() }
  }))
}

function idbGet(): Promise<StoredRecord | undefined> {
  return openDb().then(db => new Promise<StoredRecord | undefined>((resolve) => {
    if (db === undefined) { resolve(undefined); return }
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(KEY)
    request.onsuccess = () => resolve(request.result as StoredRecord | undefined)
    request.onerror = () => resolve(undefined)
  }))
}

function apply(view: WallpaperView | undefined): void {
  if (objectUrl !== undefined) { URL.revokeObjectURL(objectUrl); objectUrl = undefined }
  current = view
  if (view !== undefined) objectUrl = view.url
  if (typeof document !== 'undefined') {
    document.body.toggleAttribute(WALLPAPER_BODY_ATTR, view !== undefined)
  }
  emit()
}

/** Apply an in-memory view built from a stored/selected Blob. */
function fromRecord(record: StoredRecord): WallpaperView {
  return { kind: record.kind, url: URL.createObjectURL(record.blob), name: record.name }
}

/**
 * Rehydrate the persisted wallpaper at boot (idempotent). Safe to call multiple
 * times; a second call replaces nothing if already loaded.
 */
let initialized = false
export async function initWallpaper(): Promise<void> {
  if (initialized) return
  initialized = true
  const record = await idbGet()
  if (record === undefined) return
  apply(fromRecord(record))
}

/**
 * Import a wallpaper from a user-picked File. Videos become dynamic (autoplay
 * loop), everything else renders as a static image. Persists to IndexedDB.
 * @param file - the picked media file.
 */
export async function setWallpaperFromFile(file: File): Promise<void> {
  const kind: 'image' | 'video' = file.type.startsWith('video/') ? 'video' : 'image'
  const record: StoredRecord = { kind, type: file.type, name: file.name, blob: file }
  await idbSet(record)
  apply(fromRecord(record))
}

/** Remove the wallpaper and clear persistence. */
export async function clearWallpaper(): Promise<void> {
  await idbSet(undefined)
  apply(undefined)
}
