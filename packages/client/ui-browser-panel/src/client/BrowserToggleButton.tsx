/**
 * Browser panel toggle button. A fixed-position button that toggles the
 * browser panel visibility. Positioned in the top-right corner of the
 * viewport, near the refresh button.
 */
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useBrowserPanel } from './BrowserPanelContext.tsx'
import css from './BrowserToggleButton.module.css'

/** Localization strings (simplified for standalone use). */
const LOCALES = {
  toggle: '切换浏览器面板',
} as const

/**
 * Render the browser panel toggle button.
 * @returns the toggle button element.
 */
export function BrowserToggleButton() {
  const { isOpen, togglePanel } = useBrowserPanel()

  return (
    <button
      type="button"
      className={css.button}
      aria-label={LOCALES.toggle}
      aria-pressed={isOpen}
      title={LOCALES.toggle}
      onClick={togglePanel}
    >
      <IconBrowseOutline16 size={16} />
    </button>
  )
}
