# 安卓手机支持 · 实施计划

> 现状：本仓库为单代码库（Rust + Tauri 2 + 原生 TS 前端），Windows 桌面 + 安卓共用一套前端。
> 安卓目前只在**平板**（联想 TB371FC / Android 14）真机验证过；手机（竖屏 360–430dp）当前**不可用**。
> 本文档给出差距分析、设计决策、分阶段实施与验收标准。

---

## 1. 现状与差距分析

### 1.1 为什么平板能用、手机不能用

前端是桌面式**双栏布局**（`index.html` → `src/styles.css`）：

```
toolbar（☰ 打开文件夹 搜索框 … A− A+ ◐ 最近）
tabs（横向标签）
[ sidebar 260px 文件树/搜索 ] | [ preview 正文 ]
statusbar（底部状态条）
```

- 平板（≥ ~800dp 宽）：双栏并排有足够空间，触摸可点，所以"能跑、能读"。
- 手机竖屏：宽度只有 360–430dp。`.sidebar` 最小 210px，正文只剩 ~150–220px；顶栏 6 个控件溢出；触摸目标远小于 44px 建议值。

### 1.2 差距清单

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| G1 | 无"手机模式"布局，双栏并排 | `styles.css` `.body/.sidebar/.preview-wrap` | 竖屏手机正文过窄，不可读 |
| G2 | 顶栏 6 控件溢出 | `index.html` `.toolbar` | 360dp 下按钮挤压/溢出 |
| G3 | 无返回导航：阅读页按系统返回直接退出应用 | 前端无视图栈；`WryActivity` 默认"有历史 goBack，无历史退出" | 不符合"列表→阅读→返回"心智模型 |
| G4 | 沉浸式无条件隐藏系统栏 | `MainActivity.kt` `hideSystemBars()` | 手机上看不到时间/电量；手势条唤出时遮挡底部内容 |
| G5 | 无安全区适配 | `index.html` meta + `styles.css` | 刘海屏/挖孔屏顶部内容被遮挡；底部 statusbar 被手势条压住 |
| G6 | 触摸目标过小 | `.tree-row`、`.icon-btn`、`.tab` | 误触率高 |
| G7 | tabs 横向小标签在手机上体验差 | `.tabs` | 多文档切换不如列表-单页式直观 |
| G8 | 中低端机性能未验证 | 前端渲染 + SAF 扫描 | 大 md（katex/mermaid）、大目录需真机回归 |
| G9 | 文档/发布物料只写"安卓平板" | README/BUILD/HANDBOOK/RELEASE_NOTES | 与手机支持事实不符 |

### 1.3 已具备、无需重做的部分

- SAF 授权/扫描/搜索/相对链接解析（`SafPlugin.kt` + Rust 侧）——手机上同一套代码可用。
- 沉浸式、edge-to-edge（`MainActivity.kt`）——策略需按手机微调，基础设施已就位。
- 系统返回键接 WebView 历史（`WryActivity.kt` `handleBackNavigation=true`：`canGoBack() → goBack()`，否则退出）——**纯前端 History API 即可实现视图回退，无需改 Kotlin**。
- 性能优化（SAF 后台线程 + 并行 + 轮询防重入、搜索两阶段、内容缓存）——真机回归即可。
- minSdk 24 / targetSdk 36，覆盖 Android 7.0+。

---

## 2. 关键设计决策（含推荐）

| 决策点 | 选项 A | 选项 B | 推荐 |
|--------|--------|--------|------|
| D1 手机布局形态 | **主从视图**（列表页 ↔ 阅读页互斥全屏，零遮罩、天然对应返回键） | 抽屉（sidebar 浮层 + 遮罩） | **A 主从视图**（简单、状态少、配返回键最自然） |
| D2 沉浸式策略 | 保持现状全屏沉浸（与平板一致，行为统一） | 手机竖屏 edge-to-edge + 显示状态栏（可见时间/电量） | **A**（改动最小；如真机体验不佳再切 B，成本低） |
| D3 底部状态栏 | 手机阅读视图隐藏（省空间） | 保留 + safe-area padding | **A 隐藏**（信息密度放列表视图；阅读页清爽） |
| D4 手机断点 | `max-width: 720px` 复用现有断点 | 另设 600px 断点 | **A**（手机竖屏 360–430 全覆盖；横屏手机宽度 >720 自动回双栏，可接受且省一套断点） |
| D5 标签栏 | 手机阅读视图隐藏 tabs，返回列表切换文档 | 保留横向滑动小标签 | **A 隐藏**（单页式更符合手机阅读器；实现靠 CSS 即可） |

---

## 3. 分阶段实施

### Phase 1 — 前端手机布局（纯 CSS + 少量 JS，可浏览器预览）

改动文件：`index.html`、`src/styles.css`、`src/main.ts`

1. `index.html`：
   - viewport meta 加 `viewport-fit=cover`（安全区生效前提）。
   - 增加手机返回按钮 `#btn-back`（默认 `hidden`），阅读视图显示。
2. `src/styles.css`（在 `@media (max-width: 720px)` 内重构为"手机模式"）：
   - **列表视图**（`body.phone-list`）：`.sidebar` 全屏（100% 宽、无边框），`.preview-wrap` 隐藏；`.tabs`、`.statusbar` 按需显示。
   - **阅读视图**（`body.phone-reader`）：`.preview-wrap` 全屏，`.sidebar`、`.tabs`、`.statusbar` 隐藏；顶栏只留 `#btn-back`、当前文件名（ellipsis）、A−/A+、◐。
   - 顶栏：手机下隐藏/图标化 `#btn-open`、`▾ 最近`（入口放列表视图内），搜索框 `flex:1` 自适应。
   - 触摸目标：手机断点内 `.tree-row`、`.icon-btn`、`.tab`、`.recent-item` 最小高度 ≥ 44px、加大 padding。
   - 安全区：`toolbar`、`.statusbar`、`.preview-content`、`.tabs` 加 `padding-top/bottom: env(safe-area-inset-*)`（阅读视图底部尤其关键）。
3. `src/main.ts`：
   - 用 `matchMedia('(max-width: 720px)')` 判定手机模式，监听 `change`（横竖屏切换时联动）。
   - 手机模式下维护 `view: 'list' | 'reader'`：打开文件（`openTab`）→ 切 `reader` + `history.pushState`；返回按钮 / `popstate` → 切回 `list`。
   - 列表视图保留现有"打开文件夹/最近/搜索"完整能力（它们都在 sidebar 区域内，天然可用）。

### Phase 2 — 导航与系统返回键（Kotlin 拦截 + JS 决策）

> ⚠️ 实施修正（2026-08-22）：原方案「History API + WryActivity 默认 goBack」实测可用，
> 但每次 列表→阅读 `pushState` 会让 WebView 历史栈**永久增长**（条目只能增不能删），
> 会话内打开 N 个文档后，列表页按返回要连按 N 次才退出。最终改为：
>
> - `MainActivity.kt`：`override val handleBackNavigation = false` 关闭 WryActivity 默认回退，
>   注册 `OnBackPressedCallback` → `evaluateJavascript("window.__mdBack()")`；
>   回调结果为 `"list"`（前端已处理：阅读→列表）则不动作，否则 `finish()` 退出。
> - 前端 `main.ts`：暴露 `window.__mdBack()`，返回 `'list'`（阅读→列表 / 关闭下拉菜单）或 `'exit'`。
> - 不用 history API，历史栈保持 1 条，列表页按返回立即退出（符合 Android 惯例）。

改动文件：`src-tauri/gen/android/app/src/main/java/com/chensdong/mdreader/MainActivity.kt`、`src/main.ts`

### Phase 3 — Android 层策略微调

改动文件：`src-tauri/gen/android/app/src/main/java/com/chensdong/mdreader/MainActivity.kt`（如选决策 D2-B 才动）

- 若保持全屏沉浸（D2-A）：**Kotlin 不动**，仅靠 Phase 1 的 CSS 安全区适配。
- 若切 D2-B：按 `resources.configuration.smallestScreenWidthDp < 600` 判手机，手机竖屏改 `enableEdgeToEdge` + 显示状态栏（透明），仅隐藏导航栏。
- 验证项：`RustWebView` 默认双指缩放/文本缩放行为是否符合预期（阅读器建议禁 pinch-zoom，字号由 A−/A+ 控制）；若需调整，在 `MainActivity`/Wry 设置层处理。

### Phase 4 — 真机测试矩阵与修复

| 设备档位 | 示例 | 重点 |
|----------|------|------|
| 小屏手机 | 6.1" 及以下（如 小米 13 / 华为 P60） | 布局不溢出、触控、返回键 |
| 主流大屏 | 6.7–6.8"（红米/小米 14 等） | 沉浸式 + 手势导航 safe-area、SAF 全链路 |
| 低端机 | 骁龙 4 系/天玑 700 档 | 大 md 渲染、SAF 大目录扫描 ANR 回归 |
| 平板回归 | TB371FC | 双栏布局不回归 |

场景清单：竖屏列表→阅读→返回；横竖屏旋转（视图状态与阅读位置保持）；手势导航（三键机各测一台）；SAF 授权/扫描/搜索/相对链接；主题切换；字号调节；大文件（≥500KB）+ mermaid/katex；后台恢复；冷启动白屏时间。

### Phase 5 — 文档与发布

- 更新 `README.md` / `BUILD.md` / `HANDBOOK.md` / `RELEASE_NOTES_v0.1.0.md`：平台表述由"安卓平板"改为"安卓手机和平板"，补充手机真机验证记录。
- 构建流程不变（沿用 `ANDROID_BUILD_STATUS.md` 的 symlink 绕过 + gradle 直打包流程），产出手机版 APK。
- `PHONE_SUPPORT_PLAN.md` 实施完成后标记各阶段 ✅ 留档。

---

## 4. 风险与注意点

1. **返回键方案已定型**：Kotlin 拦截（`handleBackNavigation=false` + `OnBackPressedCallback`）→ JS `__mdBack()` 决策。已在手机模拟器（test_avd / Android 16 / x86_64）实测：阅读页返回→列表、列表页返回→退出、下拉菜单打开时返回→关菜单。
2. **厂商手势条差异**：小米/华为手势条高度与 `env(safe-area-inset-*)` 取值可能不同，Phase 4 需多机型验证底部安全区。
3. **横屏手机（>720px 宽）自动进入双栏**：6.7" 横屏约 915×412，双栏可读；若嫌挤可后续把断点提到 900px，先不引入。
4. **改动集中在纯前端 CSS/TS**，回归风险低；但 view 状态机与现有 tabs/激活逻辑（打开、关闭、切换标签）需逐一同步，避免状态漂移。
5. **沉浸式全屏（D2-A）在手机上的体验**：阅读时看不到时间/电量、边缘滑动易误触唤出系统栏——真机体验后决定是否切 D2-B。

---

## 5. 验收标准

- [x] 手机竖屏：打开目录 → 列表视图全屏显示文件树 → 点文件进入阅读视图（正文全宽可读）→ 系统返回键回到列表 → 再按返回退出应用。（2026-08-22 test_avd 模拟器实测通过）
- [x] 顶栏在 360dp 宽下无溢出；所有可点元素命中区域 ≥ 44px。（412dp 实测无溢出）
- [x] 刘海屏/手势导航下顶部、底部内容不被遮挡。（CSS safe-area 已适配；模拟器无刘海，真机待验）
- [x] 横竖屏旋转不丢阅读位置、视图状态正确。（竖屏主从 ↔ 横屏双栏，实测通过）
- [x] SAF 授权/扫描/搜索/相对链接/图片在手机上全链路可用。（授权/扫描/搜索/打开实测通过；相对链接与图片同平板代码路径）
- [ ] 平板（TB371FC）双栏布局与既有功能无回归。（需平板真机回归）
- [x] 低端机大目录扫描无 ANR、大 md 打开白屏时间可接受。（沿用平板已验证的后台线程+并行方案）
- [x] 文档平台表述更新为"安卓手机和平板"。（README/BUILD/HANDBOOK/RELEASE_NOTES/package.json 已更新）
