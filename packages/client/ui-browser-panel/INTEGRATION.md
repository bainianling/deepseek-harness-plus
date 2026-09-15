# 浏览器面板集成指南

本文档说明如何将 `@deepseek-ai/dsh-client-ui-browser-panel` 集成到 DSH Web GUI 中。

## 快速开始

### 步骤 1: 添加依赖

在 `.dsh/profiles/web/package.json` 中添加依赖：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-client-ui-browser-panel": "link:F:/opencode/deepseek-harness/packages/client/ui-browser-panel"
  }
}
```

然后在 bundles 列表中添加：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-client-ui-browser-panel"
      ]
    }
  }
}
```

### 步骤 2: 安装依赖

```bash
cd ~/.dsh/profiles/web
pnpm install
```

### 步骤 3: 在应用中渲染组件

你需要在应用的根组件中添加 `BrowserPanelProvider`、`BrowserToggleButton` 和 `BrowserPanel`。

**方法 A: 修改 apps/web/src/main.ts（推荐）**

```typescript
/** Browser entry for the Web client. */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { createRoot } from 'react-dom/client'
import { BrowserPanelProvider, BrowserPanel, BrowserToggleButton } from '@deepseek-ai/dsh-client-ui-browser-panel'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')

// 创建包装组件
function AppWithBrowserPanel() {
  return (
    <BrowserPanelProvider>
      <AppWebEntry el={el} />
      <BrowserToggleButton />
      <BrowserPanel />
    </BrowserPanelProvider>
  )
}

// 渲染
const root = createRoot(el)
root.render(<AppWithBrowserPanel />)
```

**方法 B: 作为独立插件注册**

复用现有入口文件 `packages/client/ui-browser-panel/src/client/index.tsx`：

```tsx
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserPanelProvider, BrowserPanel, BrowserToggleButton } from './index.ts'

/**
 * Register the browser panel into the DOM.
 * Call this function after the main app has mounted.
 */
export function registerBrowserPanel(): void {
  // 创建容器
  const container = document.createElement('div')
  container.id = 'dsh-browser-panel-container'
  document.body.appendChild(container)
  
  // 渲染
  const root = createRoot(container)
  root.render(
    <BrowserPanelProvider>
      <BrowserToggleButton />
      <BrowserPanel />
    </BrowserPanelProvider>
  )
}
```

然后在你的插件的 `apply()` 函数中调用它。

## 与浏览器工具集成

要让 `browser_screenshot` 工具自动将截图添加到面板，你需要：

### 选项 1: 修改 dsh-browser 插件

如果你有 `@anweat/dsh-browser` 插件的源码访问权限，可以在截图后调用 `addScreenshot`。

### 选项 2: 使用全局事件

在浏览器面板中监听自定义事件：

```tsx
// 在 BrowserPanelContext.tsx 中添加
useEffect(() => {
  const handleScreenshot = (event: CustomEvent) => {
    addScreenshot(event.detail)
  }
  window.addEventListener('dsh-browser-screenshot', handleScreenshot as EventListener)
  return () => {
    window.removeEventListener('dsh-browser-screenshot', handleScreenshot as EventListener)
  }
}, [addScreenshot])
```

然后在 dsh-browser 插件中触发事件：

```javascript
window.dispatchEvent(new CustomEvent('dsh-browser-screenshot', {
  detail: {
    url: page.url(),
    imageData: screenshotBase64,
    title: 'Screenshot',
  }
}))
```

### 选项 3: 通过 WebSocket/API

如果浏览器工具运行在后端，可以通过 WebSocket 或 API 将截图数据发送到前端。

## 测试

启动开发服务器后，你应该能看到：

1. 右上角有一个浏览器图标按钮
2. 点击按钮会打开右侧的浏览器面板
3. 面板显示"暂无截图"的提示
4. 按 ESC 键可以关闭面板

## 故障排除

### 问题：组件不显示

- 检查是否正确添加了 `BrowserPanelProvider`
- 确认 CSS 文件已正确加载
- 检查是否有 z-index 冲突

### 问题：样式不正确

- 确认 CSS Modules 已正确配置
- 检查 CSS 变量是否被覆盖
- 查看浏览器控制台是否有错误

### 问题：截图不显示

- 确认 `imageData` 是有效的 base64 字符串或图片 URL
- 检查图片大小是否超出限制
- 确认浏览器支持所使用的图片格式

## 下一步

- 实现实时 CDP 视图（需要 dsh-browser 插件支持）
- 添加拖拽调整面板宽度功能
- 实现截图标注和编辑功能
- 添加截图导出功能
