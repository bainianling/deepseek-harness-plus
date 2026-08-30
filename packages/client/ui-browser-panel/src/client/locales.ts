/** Browser panel localization strings. */
export const browserPanelLocales = {
  en: {
    'browserPanel.title': 'Browser',
    'browserPanel.close': 'Close browser panel',
    'browserPanel.toggle': 'Toggle browser panel',
    'browserPanel.empty': 'No screenshots yet',
    'browserPanel.emptyHint': 'Use browser tools to capture screenshots',
    'browserPanel.clearAll': 'Clear all',
    'browserPanel.screenshotCount': '{count} screenshots',
    'browserPanel.fullscreen': 'View fullscreen',
    'browserPanel.exitFullscreen': 'Exit fullscreen',
    'browserPanel.delete': 'Delete screenshot',
    'browserPanel.copyUrl': 'Copy URL',
    'browserPanel.copied': 'Copied!',
  },
  zh: {
    'browserPanel.title': '浏览器',
    'browserPanel.close': '关闭浏览器面板',
    'browserPanel.toggle': '切换浏览器面板',
    'browserPanel.empty': '暂无截图',
    'browserPanel.emptyHint': '使用浏览器工具来捕获截图',
    'browserPanel.clearAll': '清除全部',
    'browserPanel.screenshotCount': '{count} 张截图',
    'browserPanel.fullscreen': '全屏查看',
    'browserPanel.exitFullscreen': '退出全屏',
    'browserPanel.delete': '删除截图',
    'browserPanel.copyUrl': '复制链接',
    'browserPanel.copied': '已复制！',
  },
} as const

export type BrowserPanelLocaleKey = keyof typeof browserPanelLocales.en
