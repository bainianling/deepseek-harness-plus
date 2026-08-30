# @deepseek-ai/dsh-client-ui-browser-panel

DSH Web GUI 的内置浏览器面板组件，用于显示浏览器操作的截图历史和实时状态。

## 功能特性

- 📸 **截图历史** - 自动保存浏览器操作的截图
- 🖼️ **全屏查看** - 点击截图可全屏查看
- 🎨 **响应式设计** - 适配不同屏幕尺寸
- ⌨️ **键盘支持** - ESC 键关闭面板和全屏查看
- 🌐 **中英文支持** - 内置本地化文本

## 安装

将包添加到你的 profile 的 `package.json` 中：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-client-ui-browser-panel": "link:F:/opencode/deepseek-harness/packages/client/ui-browser-panel"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-client-ui-browser-panel"
      ]
    }
  }
}
```

## 使用方法

### 1. 在应用根组件中添加 Provider

```tsx
import { BrowserPanelProvider, BrowserPanel, BrowserToggleButton } from '@deepseek-ai/dsh-client-ui-browser-panel'

function App() {
  return (
    <BrowserPanelProvider>
      {/* 你的应用内容 */}
      <YourAppContent />
      
      {/* 浏览器面板切换按钮（固定在右上角） */}
      <BrowserToggleButton />
      
      {/* 浏览器面板（从右侧滑入） */}
      <BrowserPanel />
    </BrowserPanelProvider>
  )
}
```

### 2. 在代码中添加截图

```tsx
import { useBrowserPanel } from '@deepseek-ai/dsh-client-ui-browser-panel'

function MyComponent() {
  const { addScreenshot, openPanel } = useBrowserPanel()
  
  const handleTakeScreenshot = async () => {
    // 获取截图数据（base64 或 URL）
    const imageData = await captureScreenshot()
    
    // 添加到浏览器面板
    addScreenshot({
      url: window.location.href,
      imageData: imageData,
      title: '页面截图',
    })
    
    // 可选：自动打开面板
    openPanel()
  }
  
  return <button onClick={handleTakeScreenshot}>截图</button>
}
```

### 3. 与 browser_screenshot 工具集成

要在 `browser_screenshot` 工具执行后自动添加截图到面板，需要修改工具的回调或在工具执行后调用 `addScreenshot`。

## API

### BrowserPanelProvider

提供浏览器面板状态的 Context Provider。

### useBrowserPanel()

返回浏览器面板的状态和操作方法：

```typescript
interface BrowserPanelContextValue {
  isOpen: boolean                    // 面板是否打开
  togglePanel: () => void           // 切换面板
  openPanel: () => void             // 打开面板
  closePanel: () => void            // 关闭面板
  screenshots: BrowserScreenshot[]  // 截图列表
  addScreenshot: (screenshot: Omit<BrowserScreenshot, 'id' | 'timestamp'>) => void
  removeScreenshot: (id: string) => void
  clearScreenshots: () => void
  selectedScreenshotId: string | null
  selectScreenshot: (id: string | null) => void
}
```

### BrowserScreenshot

```typescript
interface BrowserScreenshot {
  id: string          // 唯一标识符
  timestamp: number   // 时间戳
  url: string         // 页面 URL
  imageData: string   // Base64 编码的图片数据或文件路径
  title?: string      // 可选标题
}
```

## 组件

### BrowserPanel

浏览器面板主组件，显示截图列表和全屏查看功能。

### BrowserToggleButton

切换按钮组件，固定定位在视口右上角，用于打开/关闭面板。

## 样式定制

组件使用 CSS Modules，可以通过覆盖 CSS 变量来自定义样式：

```css
:root {
  --dsh-color-bg-panel: #1a1a1a;
  --dsh-color-border: #333;
  --dsh-color-text-primary: #fff;
  --dsh-color-text-secondary: #999;
  --dsh-color-accent: #007acc;
}
```

## 开发

```bash
# 构建
pnpm build

# 监听模式
pnpm dev
```

## 许可证

MIT
