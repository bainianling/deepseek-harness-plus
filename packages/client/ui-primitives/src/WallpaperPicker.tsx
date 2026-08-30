/**
 * Wallpaper import control: a compact button that opens a file picker for a
 * static image or dynamic video, plus a clear action while one is active.
 * Framework-free React; persistence and state live in ./wallpaper.ts.
 */
import { useRef, useSyncExternalStore } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import { IconPersonalizationOutline16, IconTrashOutline16 } from './icons/index.tsx'
import { Tooltip } from './Tooltip.tsx'
import { clearWallpaper, getWallpaper, setWallpaperFromFile, subscribeWallpaper } from './wallpaper.ts'

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
}

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 10px',
  border: 'none',
  borderRadius: 14,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
}

const iconButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: 0,
  width: 28,
  justifyContent: 'center',
}

/**
 * Render the wallpaper import/clear control.
 * @returns a row with an import button and (when active) a clear button.
 */
export function WallpaperPicker() {
  const wallpaper = useSyncExternalStore(subscribeWallpaper, getWallpaper)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (file !== undefined) void setWallpaperFromFile(file)
    event.target.value = ''
  }

  return (
    <div style={rowStyle}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <Tooltip label="更换壁纸（图片 / 视频）" delayMs={500}>
        <button
          type="button"
          style={buttonStyle}
          className="dsh-wallpaper-pick"
          aria-label="更换壁纸"
          onClick={() => { inputRef.current?.click() }}
        >
          <IconPersonalizationOutline16 size={14} />
          <span>壁纸</span>
        </button>
      </Tooltip>
      {wallpaper !== undefined && (
        <Tooltip label={`清除壁纸（${wallpaper.name}）`} delayMs={500}>
          <button
            type="button"
            style={iconButtonStyle}
            aria-label="清除壁纸"
            onClick={() => { void clearWallpaper() }}
          >
            <IconTrashOutline16 size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
