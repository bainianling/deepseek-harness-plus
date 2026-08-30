# Agent Note: Local Modification Recovery Playbook (dsh-v0.1.2-alpha.1)

Status: implemented

## Problem

Upgrading `dsh-v0.1.2-alpha.1` reset the working tree to the tag, losing all uncommitted local customizations (~292 file changes: jailbreak mode, wallpaper system, LAN sharing, session move/delete, UI enhancements, and others). Without a reliable recovery procedure, future upgrades carry the same risk.

## Decision

The recovery playbook is archived as a permanent reference in this workspace so it is available to every future session. The full text (in Chinese, the language of the original record) is preserved below.

Full original path: `F:\opencode\memory\dsh-localmod-recovery-playbook.md`

### playbook body

```markdown
# deepseek-harness 本地定制丢失恢复手册（2026-08-28 实战沉淀）

## 事件回顾

升级 `dsh-v0.1.2-alpha.1` 时工作树被 reset 到 tag，**未提交的本地定制全部丢失**（jailbreak、壁纸、LAN 共享、会话移动/删除、UI 增强等约 292 文件改动）。
幸而升级前留有两个救命提交：

- `85071e49b3` — `WIP: snapshot before dsh-v0.1.2-alpha.1`（基于 `dsh-v0.1.1-rc.2` 的本地改动全量快照）
- `247056840c` — 脏 merge（父：上述 WIP + `cd5ef81481` alpha.1 发布）

最终：118 个干净文件批量恢复 + 30 个冲突文件逐个移植，`typecheck / build / test:gui` 全绿（291 文件 / 3842 测试）。

## 根因与预防（下次别再走到这一步）

1. **升级前必须 `git add -A && git commit --no-verify` 打 WIP 快照**（runbook 步骤 3）。本次能救回来全靠这一步。
2. 本地定制尽量固化成提交/分支，不要长期裸工作树。
3. 升级脚本 `dsh-update-on-startup.ps1` 的 `Protect-WebProfile` 等函数可能误删关键配置（本次反转了 `@anweat/dsh-browser` 规则，见 runbook 问题 1/12）——升级后先核对脚本逻辑。

## 恢复步骤（可复用）

### 第 1 步：定位快照提交

```powershell
git reflog                      # 找 "WIP: snapshot before ..." 提交
git log --oneline --all -30     # 找把 tag 作为父的脏 merge
```

记住三个坐标：`<base tag>`（改动基于的版本）、`<wip>`（本地快照）、`<new tag>`（升级目标）。

### 第 2 步：列清单，三分法分类

```powershell
git diff <base tag> <wip> --stat      # 全部本地改动
git diff <new tag> -- <path>          # 工作区 vs 上游
```

每个文件分到三类：

| 类别 | 判据 | 动作 |
|------|------|------|
| A 干净恢复 | `<wip>` 有改动，且工作区当前内容 == `<new tag>` 内容 | `git checkout <merge> -- <file>` 批量恢复 |
| B 冲突移植 | `<new tag>` 也改了同一文件 | 逐个手动移植（见第 4 步） |
| C 有意删除 | 上游已删除的包/文件（本次：`packages/client/runtime`、`packages/host/apiproxy`、旧 `pnpm-lock.yaml`、误提交的 `lib/*.js\|d.ts\|map`） | **不恢复**，功能需移植到新架构 |

### 第 3 步：批量恢复 A 类

`git checkout <merge> -- <files>`，一次提交固化。

### 第 4 步：B 类冲突移植

- 冲突文件多时按功能簇拆给并行子代理（本次分 3 簇：UI 组件簇 / 设置与预设簇 / prompt 与测试簇 + 会话移动/删除独立簇）。
- 每个文件的标准操作：`git diff <base tag> <wip> -- <file>` 看用户改动意图 → `git show <new tag>:<file>` 看上游新形态 → 在新形态上重放用户意图。
- **API 迁移速查表**（跨版本升级常备，随版本更新）：

| 旧（rc.2） | 新（alpha.1） |
|---|---|
| `@deepseek-ai/dsh-client-runtime`（已删包） | 按用途拆：`@deepseek-ai/cordis`(Context)、`@deepseek-ai/dsh-session/types`(SessionId)、`@deepseek-ai/dsh-client-store`(createSnapshotStore/SnapshotStore)、`@deepseek-ai/dsh-client-ui-settings/client`(SettingsScope) |
| `CallId` | `ToolCallId`（`@deepseek-ai/dsh-llm`） |

### 第 5 步：门禁循环

```
pnpm run typecheck  →  pnpm run build  →  pnpm run test:gui
```

### 第 6 步：测试失败分诊（本次最耗时的环节，四条决策原则）

1. **用户 WIP 改过该测试** → 移植用户的测试改动（例：input-bar 座位断言加入 `image-import`/`jailbreak`）。
2. **上游测试与用户成文设计冲突** → 按用户设计改测试，注释写明理由（例：directory-picker 上游断言 0.0.0.0 绑定降级 browse；用户 resolve.ts 注释说明 Web 传输已钉死 `pickDirectory` loopback，故改断言 native）。
3. **快照测试** → `vitest run <spec> -u` 重新生成，**必须检查 diff 只含预期新功能**（例：sidebar 快照仅新增壁纸行）。
4. **超时类失败** → 先单独跑该文件；单独通过 = 并发负载 flaky（例：code-block 上游写死 `vi.waitFor 5s`），不改上游代码，重跑确认即可。

### 第 7 步：外围核对

- profile（`~\.dsh\profiles\web\package.json`）：bundles 规则按 runbook 问题 1 版本形态核对。
- 桌面端（`G:\DSH-Desktop\main.js`）：按 runbook 问题 12 核对令牌认证适配。
- 硬编码文案：用户 WIP 原样恢复的中文硬编码（如壁纸按钮"更换壁纸"）`verify-client-ui-i18n` 会标记，属已知遗留，不阻塞。

## 本次关键事实索引

- 令牌认证 / 桌面端适配 → `dsh-update-runbook.md` 问题 12
- `@anweat/dsh-browser` bundles 规则 → `dsh-update-runbook.md` 问题 1
- 桌面端快捷方式修复细节 → `dsh-desktop-fix-2026-08-28.md`
- 恢复的本地功能清单：jailbreak 模式、壁纸系统（WallpaperLayer/Picker + sidebar 按钮 + AppFrame 视口）、LAN 共享（0.0.0.0 绑定 + `lanShare` 信任栅栏 + `/lan-share`、`/server/shutdown` 端点 + 面板控件）、输入栏图片导入附件、会话移动/删除（workspace-controller 新架构）、ModelBalanceAction、StopServerAction、CompactionCard、connection 动态 `resolveTrustedHosts`

## 恢复后状态（2026-08-28）

- HEAD：`247056840c`（脏 merge），工作树含全部恢复/移植改动（未最终提交，用户决定何时固化）
- `pnpm run typecheck` ✅ 0 错误；`pnpm run build` ✅；`pnpm run test:gui` ✅ 291/291 文件、3842 通过
```

## Alternatives considered

- **Store the playbook only at its original path `F:\opencode\memory\`** — rejected because that path is outside the workspace and inaccessible to future agent sessions.
- **Rewrite the playbook into English** — rejected because the original Chinese record is the authoritative source, and a translation adds cost and risk of drift.
- **Append to AGENTS.md** — rejected because the playbook is 89 lines of operational procedure, far too long for the agent's directive file.

## Consequences

- The full recovery playbook is now available to every future session in this workspace, including the exact git coordinates (`85071e49b3`, `247056840c`), the three-class file triage method, the API migration table, and the four test-diagnosis principles.
- The playbook retains its original Chinese text, matching the language of the original record at `F:\opencode\memory\dsh-localmod-recovery-playbook.md`.
- The commit snapshot procedure (`git add -A && git commit --no-verify` before any upgrade) is now explicitly documented as the critical prevention step.

## Addendum: 2026-08-28 晚 侧边栏消失事件（react 19 依赖污染）

**现象**：:3080 GUI 左侧侧边栏整列空白（会话面板存活）；`pnpm run test:gui` 97 个文件崩于 `TypeError: Cannot read properties of undefined (reading 'ReactCurrentDispatcher')`，栈指向 `react-dom@18.3.1_react@19.2.8` 变体。

**根因链**：

1. 未完成的脚手架包 `packages/client/ui-browser-panel`（"内置侧边栏浏览器"功能）把 `react: ^19.1.0` 写进 `dependencies`，`pnpm install` 引入 react@19.2.8。
2. 根 devDeps 的 `@testing-library/react`（peer 范围 ^18||^19）被 pnpm auto-install-peers 按锁里最高版本补成 react@19，坏变体 hoist 到根 `node_modules/@testing-library/react`。
3. 所有自身不声明 `@testing-library/react` 的 client 包（spec 上溯解析到根）加载坏变体 → react-dom@18 读 react@19 内部 → 渲染即崩。
4. 该包手写的 `tsdown.config.ts`（无 externals、无 CSS 插件）把 ui-primitives 源码连同 `.module.css` 打进自己的 bundle，触发 tsdown css-guard，根构建红；其 `tsconfig.json` extends 深度也错（`../../` 应为 `../../../`）。

**修复**：

- `ui-browser-panel/package.json`：react 移到 devDependencies `^18.2.0`，workspace 依赖改 `workspace:^` 放 dev。
- 根 devDeps 显式钉 `react`/`react-dom` `18.3.1`（+ `pnpm.overrides` lightningcss 1.32.0），杜绝 auto-install-peers 再选 19；`pnpm update @testing-library/react` 重解析根实例。
- `ui-browser-panel/tsdown.config.ts` 改为 `defineConfig([{ entry: '' }])` 跳过所有 build face（未注册脚手架不参与构建）；tsconfig extends 修正。
- 清除 `ui-sidebar/src/client/` 残留编译产物（`*.js/*.d.ts/*.map`，手册 C 类），注意**恢复被误删的跟踪文件 `src/css-modules.d.ts`**。
- `session-file-import.host.spec.ts` 的 StubAdapter 补 `stream` 抽象实现；icons spec 计数 71→73（WIP 新增 IconFileOutline16/IconClockOutline16）。

**预防规则**：

- client 包永远不把 react 放 dependencies（react 是 shell 种子化的平台模块，只进 devDependencies）。
- 新建 client 包要么完成三注册面（tsconfig 聚合引用 + web-app `cordis.patch.yml` 行 + web-app package.json 依赖）走 `clientBundle` 预设，要么 `entry: ''` 跳过构建；手写 tsdown 配置是 css-guard 陷阱。
- 升级/修复期间不要顺手 `pnpm dedupe`/`pnpm update` 无关包（本次 dedupe 把 lightningcss 顶到 1.33 改变 tsdown CSS 管线）。
- 清理残留编译产物时先 `git status` 区分跟踪/未跟踪，跟踪的 `.d.ts` 声明文件（css-modules.d.ts）不是残留。

**验证（2026-08-28 晚）**：根构建全绿；`test:gui` 290/291——唯一失败为手册原则 4 点名的上游 flaky（code-block 懒加载语法 5s 硬等待，并发负载下超时，单独跑绿，按决策不改上游）；无头浏览器（playwright + 启动日志里的 token URL）确认侧边栏完整渲染（品牌行/壁纸/新会话/自动化/工作区树/页脚），console 零错误。另修 `restart-dsh-web.ps1` 健康探针：信任栅栏下裸 `/` 返回 401 即视为已启动。

**桌面端后续（同晚）**：agent 的替代 :3080 实例与桌面端冲突——桌面端读不到替代实例的令牌，且旧托盘实例用单实例锁吸收新的快捷方式启动（表现为"启动不了"）。处置顺序：`taskkill` 替代监听进程释放 3080 → 按 `ExecutablePath -match 'DSH-Desktop'` 全杀 Electron 托盘树 → 重启快捷方式；窗口标题变回页面标题（如 `… — DSH 本地构建`）即 SPA 加载成功。运行规则：**:3080 归桌面端所有**（`G:\DSH-Desktop\main.js` 从本仓库起服务并捕获令牌），agent 验证用的替代实例用完必须释放，否则桌面端必复现"启动不了"。

**2026-08-29 复发：启动即崩 `declares no dsh.bundle`**：home profile（`~\.dsh\profiles\web\package.json`）的 `dsh.profile.bundles` 被塞入未完成包 `@deepseek-ai/dsh-client-ui-browser-panel`（无 `dsh.bundle` 声明、无补丁文件），`loadProfile` 直接 throw，服务起不来。处置：从 `bundles` 删除该行（依赖 link 保留无害）。规则：**bundles 只放有 `dsh.bundle` 声明的成品包**；脚手架包最多进 `dependencies`，进 bundles 前必须完成 bundle 三件套（`dsh.bundle` 字段 + cordis 补丁文件 + 构建产物）。复发自查加一条：服务器日志出现 `declares no dsh.bundle` 时，核对 home profile bundles 与包 manifest。

**2026-08-29 白屏（孤儿窗口）**：截屏实证"白屏"是一个**孤儿加载页窗口**：`main.js` 的接管/重建路径创建新窗口时不销毁旧窗口，且 `close` 事件无条件拦截藏托盘——残留白窗既不能用也关不掉，叠在好窗口后面。修复（`G:\DSH-Desktop\main.js`）：单窗口不变量（`createMainWindow` 先 destroy 存活旧窗）；`close` 只拦截当前单例（身份比较），被取代窗口可正常关闭；`startServerAndOpenWindow` 第 5 步 loadURL 前 destroy 所有杂窗；另保留 `show → webContents.invalidate()` 防托盘再显示合成器白屏。复发自查：白屏先截屏数窗口；双窗 = 孤儿窗口（重启生效新逻辑）；单窗白且 diag 无 `render-process-gone` = 合成器白屏（刷新按钮/重启）；有 `render-process-gone` = 问题三链。

**浮光（fuguang）"绑定启动"排查（2026-08-29）**：harness 全链路（main.js、`dsh-update-on-startup.ps1`、个人插件、profile 插件包）grep 无浮光引用，**无绑定代码**。真因是注册表 `HKCU\...\Run` 两个浮光登录自启动项：`electron.app.浮光`（打包版，有数据）与 `electron.app.Electron`（裸 dev electron，无数据空白窗）——登录自启与 harness 启动时机重合造成绑定错觉。按用户选择已删 `electron.app.Electron`、保留打包版；并结束残留的 `npm --prefix F:/fuguang run dev/app` dev 进程树。复发自查：再有"无数据浮光自启"，先查注册表 Run 与 fuguang 进程父链，不要怀疑 harness。

**2026-08-30 再复发：同一 `declares no dsh.bundle`**：并行开发会话按 `ui-browser-panel/INTEGRATION.md` 步骤 1 把该行**写回** home profile bundles（同时还新增 `dsh-ai-news`/`dsh-collab-studio`/`dsh-model-bench` 三个 bundle），删行治标不治本。根治：给 `ui-browser-panel` 补齐 bundle 三件套——`package.json` 加 `dsh.bundle.patch`、新建 `cordis.patch.yml`（行 `id: ui-browser-panel`，`inject: [connection]`，与 `src/index.ts` 的 `ctx.inject(['connection'])` 对应）；tsdown 预设已由并行会话恢复为 `clientBundle`；`pnpm run build` 产出四个新包的 `lib/`（host 聚合引用早已就位）。重启后启动正常。规则升级：**home profile bundles 是共享表面，并行会话会重写它；修此类启动崩溃必须补声明+构建，不要删行**；boot 报错只点名第一个坏 bundle，修完要再启动验证后续行。

**2026-08-30 白屏（lib 产物不一致）**：SPA 实际已加载（窗口标题为中文"DSH 本地构建"= 运行时标题，桌面端默认标题是英文 APP_NAME），但根槽崩溃整窗白屏。无头探测（临时接管 :3080 起自己的实例拿新令牌）拿到铁证：`TypeError: useCurrentSession is not a function at AppFrame`。根因：并行会话 14:17 给 `ui-session` 源码加了 `currentSession` hook（`provideRoot({ hooks: { currentSession: service.currentSession, ... } })`），但 `ui-session/lib/client.js` 是 14:08 构建的**旧产物**，不含该 hook；`ui-layout` 的 lib（14:59 构建，最新）在调 `useCurrentSession` → 渲染器绑定不出该 hook → AppFrame 崩溃 → 根槽错误边界吞掉整窗。修复：`tsc -b packages/client/ui-session` + `pnpm --filter @deepseek-ai/dsh-client-ui-session bundle`（单独编译绕开被并行会话测试卡住的整面构建），同类 stale 扫描发现 `locale`（14:27>14:08）一并重编。**新增排查规则：GUI 白屏/组件缺失先做"src 与 lib 新旧对比扫描"**（每个 `packages/client/*` 的 src 最新 mtime vs `lib/client.js` mtime），产物不一致是本机并行开发最易踩的坑；并行会话的 client 面测试尚未跟上（37 个测试缺 `useCurrentSession` 夹具，`tsc -b tsconfig.client.json` 全红）——属于其 WIP，未代修，必要时按"改过时测试"惯例补夹具。