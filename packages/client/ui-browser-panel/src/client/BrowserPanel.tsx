/**
 * Browser panel root component. Renders a fixed-position right-side panel that
 * displays browser screenshots and provides quick access to browser state.
 * The panel slides in/out from the right edge with a smooth transition.
 * Content is scrollable with pointer-aware scrollbar behavior.
 *
 * This component uses the BrowserPanelContext for state management, making it
 * easy to integrate without the complex slots system.
 */
import { useCallback, useEffect } from 'react'
import clsx from 'clsx'
import {
  IconBrowseOutline16, IconCloseOutline16, IconRefreshOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useBrowserPanel } from './BrowserPanelContext.tsx'
import type { BrowserScreenshot } from './contract/slots.ts'
import css from './BrowserPanel.module.css'

/** Localization strings (simplified for standalone use). */
const LOCALES = {
  title: '浏览器',
  close: '关闭浏览器面板',
  toggle: '切换浏览器面板',
  empty: '暂无截图',
  emptyHint: '浏览器工具的截图会自动出现在这里',
  clearAll: '清除全部',
  screenshotCount: '{count} 张截图',
  fullscreen: '全屏查看',
  exitFullscreen: '退出全屏',
  delete: '删除截图',
  capture: '捕获当前页面',
  refresh: '刷新截图历史',
  unavailable: '浏览器服务未启用',
  noActivePage: '没有活动页面',
  localShot: '本地截图',
} as const

/** Format timestamp to relative time string. */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (seconds < 60) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  return new Date(timestamp).toLocaleDateString()
}

/** Extract hostname from URL for display; empty URLs are local snapshots. */
function extractHostname(url: string): string {
  if (url === '') return LOCALES.localShot
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Screenshot item component. */
function ScreenshotItem({
  screenshot,
  onView,
  onDelete,
}: {
  screenshot: BrowserScreenshot
  onView: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div
      className={css.screenshotItem}
      onClick={() => { onView(screenshot.id) }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onView(screenshot.id)
        }
      }}
    >
      <img
        src={screenshot.imageData}
        alt={screenshot.title ?? screenshot.url}
        className={css.screenshotThumbnail}
        loading="lazy"
      />
      <div className={css.screenshotInfo}>
        <div className={css.screenshotUrl} title={screenshot.url}>
          {extractHostname(screenshot.url)}
        </div>
        <div className={css.screenshotTime}>
          {formatRelativeTime(screenshot.timestamp)}
        </div>
      </div>
      <div className={css.screenshotActions}>
        <button
          type="button"
          className={css.actionButton}
          aria-label={LOCALES.delete}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(screenshot.id)
          }}
        >
          <IconTrashOutline16 size={14} />
        </button>
      </div>
    </div>
  )
}

/** Fullscreen viewer overlay. */
function FullscreenViewer({
  screenshot,
  onClose,
}: {
  screenshot: BrowserScreenshot
  onClose: () => void
}) {
  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('keydown', handleKeyDown) }
  }, [onClose])

  return (
    <div
      className={css.fullscreenOverlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={LOCALES.fullscreen}
    >
      <img
        src={screenshot.imageData}
        alt={screenshot.title ?? screenshot.url}
        className={css.fullscreenImage}
        onClick={(e) => { e.stopPropagation() }}
      />
      <button
        type="button"
        className={css.fullscreenClose}
        onClick={onClose}
        aria-label={LOCALES.exitFullscreen}
      >
        ×
      </button>
      <div className={css.fullscreenInfo}>
        {screenshot.url}
      </div>
    </div>
  )
}

/**
 * Render the browser panel.
 * @returns the browser panel element tree.
 */
export function BrowserPanel() {
  const {
    isOpen,
    closePanel,
    screenshots,
    selectScreenshot,
    selectedScreenshotId,
    removeScreenshot,
    clearScreenshots,
    busy,
    available,
    activeUrl,
    capture,
    refresh,
  } = useBrowserPanel()

  // Find the currently selected screenshot for fullscreen view
  const selectedScreenshot = selectedScreenshotId !== null
    ? screenshots.find(s => s.id === selectedScreenshotId) ?? null
    : null

  const handleViewScreenshot = useCallback((id: string) => {
    selectScreenshot(id)
  }, [selectScreenshot])

  const handleCloseFullscreen = useCallback(() => {
    selectScreenshot(null)
  }, [selectScreenshot])

  const handleDeleteScreenshot = useCallback((id: string) => {
    removeScreenshot(id)
    // If we deleted the currently viewed screenshot, close fullscreen
    if (selectedScreenshotId === id) {
      selectScreenshot(null)
    }
  }, [removeScreenshot, selectScreenshot, selectedScreenshotId])

  const handleClearAll = useCallback(() => {
    clearScreenshots()
    selectScreenshot(null)
  }, [clearScreenshots, selectScreenshot])

  // Close on Escape key when panel is visible
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('keydown', handleKeyDown) }
  }, [isOpen, closePanel])

  const handleCapture = useCallback(() => {
    void capture()
  }, [capture])

  const handleRefresh = useCallback(() => {
    void refresh()
  }, [refresh])

  const statusLabel = !available
    ? LOCALES.unavailable
    : activeUrl !== undefined && activeUrl !== '' ? extractHostname(activeUrl) : LOCALES.noActivePage

  return (
    <>
      <div className={clsx(css.root, isOpen && css.open)}>
        <div className={css.header}>
          <div className={css.title}>
            {LOCALES.title}
          </div>
          <div className={css.headerActions}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={LOCALES.refresh}
              title={LOCALES.refresh}
              onClick={handleRefresh}
              disabled={busy}
            >
              <IconRefreshOutline16 size={16} />
            </button>
            <button
              type="button"
              className={clsx(css.iconButton, css.captureButton)}
              aria-label={LOCALES.capture}
              title={LOCALES.capture}
              onClick={handleCapture}
              disabled={busy || !available}
              data-busy={busy || undefined}
            >
              <IconBrowseOutline16 size={16} />
            </button>
            <button
              type="button"
              className={css.iconButton}
              aria-label={LOCALES.close}
              onClick={closePanel}
            >
              <IconCloseOutline16 size={16} />
            </button>
          </div>
        </div>

        <div className={css.statusBar} data-available={available || undefined} title={activeUrl ?? statusLabel}>
          <span className={css.statusDot} aria-hidden="true" />
          <span className={css.statusText}>{statusLabel}</span>
        </div>

        <div className={css.content}>
          {screenshots.length === 0
            ? (
              <div className={css.empty}>
                <IconBrowseOutline16 size={48} className={css.emptyIcon} />
                <div className={css.emptyText}>{LOCALES.empty}</div>
                <div className={css.emptyHint}>{LOCALES.emptyHint}</div>
              </div>
            )
            : (
              <div className={css.screenshotList}>
                {screenshots.map(screenshot => (
                  <ScreenshotItem
                    key={screenshot.id}
                    screenshot={screenshot}
                    onView={handleViewScreenshot}
                    onDelete={handleDeleteScreenshot}
                  />
                ))}
              </div>
            )}
        </div>

        {screenshots.length > 0 && (
          <div className={css.footer}>
            <span className={css.screenshotCount}>
              {LOCALES.screenshotCount.replace('{count}', String(screenshots.length))}
            </span>
            <button
              type="button"
              className={css.clearButton}
              onClick={handleClearAll}
            >
              {LOCALES.clearAll}
            </button>
          </div>
        )}
      </div>

      {/* Fullscreen overlay rendered outside the panel to escape overflow clipping */}
      {selectedScreenshot !== null && (
        <FullscreenViewer
          screenshot={selectedScreenshot}
          onClose={handleCloseFullscreen}
        />
      )}
    </>
  )
}
