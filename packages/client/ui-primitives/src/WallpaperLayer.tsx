/**
 * Full-screen wallpaper layer: renders the user's static image or looping
 * video fixed behind the whole app. While active it injects a sheet that makes
 * the base AND the sidebar/panel surfaces translucent (light/dark aware) so the
 * media shows through the entire interface with no opaque "film". Videos start
 * muted (autoplay policy) and are unmuted on the first user gesture so their
 * audio plays once the user interacts.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { getWallpaper, initWallpaper, subscribeWallpaper } from './wallpaper.ts'

/** Translucent-surface overrides: low alpha so the wallpaper reads everywhere,
 * including the sidebar, without a white film. */
const WALLPAPER_SHEET = `
body[data-dsh-wallpaper] {
  --dsw-alias-bg-base: transparent;
  --dsw-specific-sidebar-fill: rgba(248, 250, 255, 0.35);
  --dsw-alias-bg-layer-1: rgba(255, 255, 255, 0.28);
  --dsw-alias-bg-layer-2: rgba(245, 246, 247, 0.38);
  --dsw-alias-bg-layer-3: rgba(240, 242, 245, 0.5);
}
body[data-dsh-wallpaper][data-ds-dark-theme] {
  --dsw-specific-sidebar-fill: rgba(21, 21, 23, 0.35);
  --dsw-alias-bg-layer-1: rgba(27, 27, 28, 0.28);
  --dsw-alias-bg-layer-2: rgba(35, 35, 36, 0.38);
  --dsw-alias-bg-layer-3: rgba(44, 44, 46, 0.5);
}
`

const layerStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: -1,
  overflow: 'hidden',
  pointerEvents: 'none',
}

const mediaStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
}

/**
 * Render the active wallpaper (if any) behind the app.
 * @returns the fixed background layer, or null when no wallpaper is set.
 */
export function WallpaperLayer() {
  const wallpaper = useSyncExternalStore(subscribeWallpaper, getWallpaper)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => { void initWallpaper() }, [])

  // Videos must start muted to satisfy autoplay policy; unmute on the first
  // user gesture so a clip that carries audio actually plays its sound.
  const isVideo = wallpaper?.kind === 'video'
  useEffect(() => {
    if (!isVideo) return
    const unmute = (): void => {
      const video = videoRef.current
      if (video !== null) {
        video.muted = false
        void video.play().catch(() => {})
      }
      window.removeEventListener('pointerdown', unmute)
      window.removeEventListener('keydown', unmute)
    }
    window.addEventListener('pointerdown', unmute)
    window.addEventListener('keydown', unmute)
    return () => {
      window.removeEventListener('pointerdown', unmute)
      window.removeEventListener('keydown', unmute)
    }
  }, [isVideo, wallpaper?.url])

  return (
    <>
      <style>{WALLPAPER_SHEET}</style>
      {wallpaper !== undefined && (
        <div style={layerStyle} aria-hidden="true">
          {wallpaper.kind === 'video'
            ? (
              <video
                ref={videoRef}
                style={mediaStyle}
                src={wallpaper.url}
                autoPlay
                muted
                loop
                playsInline
              />
              )
            : (
              <img style={mediaStyle} src={wallpaper.url} alt="" />
              )}
        </div>
      )}
    </>
  )
}
