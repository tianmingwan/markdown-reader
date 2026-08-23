# 安卓构建 · 交接状态（2026-08-22 更新：APK 已产出 ✅）

> 给接手者的环境快照。**生成 APK 前务必先读本文档**，避免重复踩坑。

## 🎉 成果

**APK 已成功构建**：`src-tauri\gen\android\app\build\outputs\apk\debug\app-debug.apk`（44.8MB，含 arm64/arm/x86/x86_64 四个 ABI），桌面副本：`C:\Users\aakb\Desktop\markdown阅读器-安卓版.apk`

## ✅ 环境已 100% 就绪

| 项 | 位置 | 说明 |
|---|---|---|
| Android SDK | `D:\Android\Sdk`（platform-36 + build-tools 35/36） | `ANDROID_HOME` 已设置 |
| JDK | `D:\Java\jdk-21.0.12+8` | `JAVA_HOME` 已设置 |
| NDK | `D:\Android\Sdk\ndk\27.3.13750724` | 从腾讯镜像手动解压（sdkmanager 下载会损坏） |
| rustup 安卓目标 | 4 个（aarch64/armv7/i686/x86_64-linux-android） | 用本地离线包 `C:\rustdist` 安装 |
| cargo-ndk | `%USERPROFILE%\.cargo\bin\` | v4.1.2（手动运行报 "No chunk"，tauri CLI 内部可用） |
| cargo/npm 国内源 | rsproxy.cn + npmmirror | 已配置 |
| 安卓工程 | `src-tauri\gen\android\` | 已 init（tauri CLI 会在 build 时补生成 tauri.settings.gradle / tauri.build.gradle.kts） |
| SAF 插件 | `gen\android\app\src\main\java\com\chensdong\mdreader\SafPlugin.kt`（**包名必须为 `com.chensdong.mdreader`**，与 Rust 侧注册一致；新版 @TauriPlugin/@Command/@ActivityCallback API） | 已就位，**无需 MainActivity 注册** |

## ⚠️ 关键：Windows symlink 限制与绕过方案（务必照做）

**问题**：`tauri android build` 要把 .so 用**符号链接**放入 jniLibs，但本机未开 Windows **开发者模式**（非管理员无法开），tauri CLI 在此步失败（已知 bug #10937）。**当前账号非管理员，无法开启开发者模式。**

**已采用的绕过流程**（下次重新构建 APK 照此执行）：

```powershell
# 1) 编译 4 个 ABI 的 .so（每个都会在 symlink 步骤失败退出，但 .so 已产出，属预期）
cd "C:\Users\aakb\Desktop\markdown 阅读器"
npx tauri android build -t aarch64    # 首次约 2-5 分钟，失败可忽略
npx tauri android build -t armv7
npx tauri android build -t i686
npx tauri android build -t x86_64

# 2) 手动复制 .so 到 jniLibs（跳过 tauri 的 symlink）
#    C:\mdrtarget\<triple>\release\libmdreader_lib.so → gen\android\app\src\main\jniLibs\<abi>\libmdreader_lib.so
#    映射：aarch64-linux-android→arm64-v8a, armv7-linux-androideabi→armeabi-v7a, i686-linux-android→x86, x86_64-linux-android→x86_64

# 3) 手动拷贝前端资源到 assets（**重要！tauri CLI 才会自动拷，直接 gradle 打包必须手动**；
#    漏了这步 APK 能装能开但白屏——WebView 加载不到 index.html）：
Copy-Item dist\* src-tauri\gen\android\app\src\main\assets\ -Recurse -Force
Copy-Item src-tauri\tauri.conf.json src-tauri\gen\android\app\src\main\assets\ -Force

# 4) gradle 直接打包（已禁用 app/build.gradle.kts 里的 id("rust") 防止再次触发 symlink）
$env:JAVA_HOME = "D:\Java\jdk-21.0.12+8"
& "src-tauri\gen\android\gradlew.bat" -p "src-tauri\gen\android" assembleDebug --no-daemon
# APK: src-tauri\gen\android\app\build\outputs\apk\debug\app-debug.apk
```

> ⚠️ **勿把 SafPlugin.kt 放进 `...\mdreader\saf\` 子目录或改包名为 `com.chensdong.mdreader.saf`**
> （2026-08-22 真机实测踩过：Rust 侧按 `com.chensdong.mdreader` + `SafPlugin` 反射加载，
> 包名不匹配 → 启动即崩 `ClassNotFoundException: com.chensdong.mdreader.SafPlugin`）。
> 文件放 `...\mdreader\SafPlugin.kt`，包名 `com.chensdong.mdreader`。

**已对 gen/android 做的修改**（重新 `tauri android init` 会覆盖，勿重跑 init）：
- `gradle.properties`：加 `android.overridePathCheck=true`（中文路径）
- `settings.gradle` / `build.gradle.kts` / `buildSrc`：阿里云/腾讯镜像仓库（勿覆盖）
- `app\build.gradle.kts`：注释 `id("rust")` + 删除 `rust {}` 块
- `MainActivity.kt`（手机主从视图，2026-08-22 加；**权威副本在 `src-tauri\android-extras\MainActivity.kt`**，重跑 init 后按 BUILD.md 拷回）：
  - `override val handleBackNavigation = false`：关闭 WryActivity 默认「WebView 历史回退」
    （history.pushState 会让历史栈随打开文档数永久增长，列表页按返回需连按 N 次才退出）
  - 注册 `OnBackPressedCallback` → `evaluateJavascript("window.__mdBack()")`：
    返回 `"list"` 表示前端已处理（阅读→列表 / 关闭下拉菜单），否则 `finish()` 退出
  - `if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)`：debug 构建开 WebView 调试

> 若日后能开开发者模式（设置→开发者选项→开发者模式，需管理员），可直接 `tauri android build`，无需以上绕过。

## 插件 API 说明（已按新版重写）

- **Rust 侧**（`src-tauri\src\saf\`）：`Builder::new("saf").setup(|app, api| api.register_android_plugin("com.chensdong.mdreader", "SafPlugin") → app.manage)`，命令里 `app.state::<SafPlugin<Wry>>()` 调 `run_mobile_plugin("method", payload)`。
- **Kotlin 侧**（`android-extras\SafPlugin.kt`）：`@TauriPlugin class SafPlugin(activity: Activity) : Plugin(activity)`，命令用 `@Command fun xxx(invoke: Invoke)`，参数 `invoke.parseArgs(Args::class.java)`（`@InvokeArg` 类），activity 结果用 `startActivityForResult(invoke, intent, "回调名")` + `@ActivityCallback fun 回调名(invoke, result: ActivityResult)`。
- ⚠️ **两个 Kotlin 侧必守原则**（dp4flash 大目录真机踩坑）：
  1. **耗时的 SAF 查询/文件读取必须放后台线程**：tauri 插件命令默认跑 Android 主线程，大目录递归扫描会卡死主线程 → **ANR → 白屏**。所有命令已用 `runAsync(invoke){...}` 包成后台线程（`invoke.resolve/reject` 是 JNI 调用，后台线程可安全回调）。
  2. **子目录 children 查询必须用「目录自身的 docId」**：`buildChildDocumentsUriUsingTree(uri, getTreeDocumentId(uri))` 在子目录上永远返回**树根**的 children（旧写法导致子目录内容自引用重复、md 计数为 0）。正确写法见 `buildTree` 内注释：先 `substringBeforeLast("/document/")` 取 tree 部分，再按 uri 是否含 `/document/` 段取 `getDocumentId(uri)` 或 `getTreeDocumentId(treeUri)`。

## ✅ 真机实测（2026-08-22，联想 TB371FC 平板 / Android 14 / arm64-v8a）

**结论：APK 可安装、可运行，SAF 全链路工作正常，含大目录（199 个 md）实测。**

| 验证项 | 结果 |
|---|---|
| 安装 | `adb install` 成功（44.8MB，arm64-v8a 原生库匹配） |
| 启动 | 冷启动 ~400ms，进程存活、无崩溃、无 FATAL 日志 |
| 前端资源 | WebView 加载 `http://tauri.localhost/`，标题「markdown阅读器」，UI 正常渲染 |
| 会话恢复 | 自动恢复上次 SAF 授权目录 |
| SAF 授权 | 系统选择器授权 `dp4flash正式版审查修改v2` 成功，授权持久化 |
| SAF 扫描 | 大目录 `dp4flash正式版审查修改v2`（23 个子目录）→ **199 个 md 全部正确列出**，子目录展开显示正确文件名 |
| 阅读渲染 | 打开 `宪法精讲1宪法概述_d3cccb.md`（14.2KB/5714字）→ 标题/列表/引用渲染正常 |
| 标签名 | 修复前显示百分号编码乱码（SAF docId）；现显示正确文件名 |
| 全文搜索 | 修复前安卓搜索永远空（走文件系统遍历 + async 命令链路断裂）；现「宪法」34 条、「课程定位」3 条（文件名+内容+摘要高亮） |
| 沉浸式 | 状态栏（时间/电池）/导航栏已隐藏，内容全屏覆盖 |
| 隐私 | 全项目"陈守冬"已清除（标题/文档/配置/Cargo authors/桌面 APK 文件名） |
| 防 ANR | 修复前打开大目录 10s+ 主线程卡死触发 4 次 ANR；修复后（后台线程+并行+轮询防重入）**连续运行无新 ANR** |

> 本次累计修复的问题（详见《PERFORMANCE.md》）：
> 1. **SafPlugin 包名不匹配**（`com.chensdong.mdreader.saf` → `com.chensdong.mdreader`）→ 启动崩溃。
> 2. **assets 未打包**（直接 gradle 打包跳过了 tauri CLI 的资源拷贝）→ 白屏（注意：前端实际由 .so 内嵌资源提供，assets 仅冗余）。
> 3. **SAF 扫描卡主线程 → ANR 白屏**（大目录）→ 所有插件命令改后台线程 + 前端 4s 轮询加防重入。
> 4. **子目录 children 查询返回根目录内容**（`getTreeDocumentId` 误用）→ 子目录自引用重复、md 计数为 0。
> 5. **搜索在安卓失效**：a) Rust 搜索走文件系统遍历，对 SAF content URI 无效 → Kotlin 实现 SAF 搜索；b) 移动端插件命令不能是 async（JNI 响应丢失）→ 同步命令 `search_files_saf`；c) `resolveObject(JSONArray)` 被 Jackson 序列化成 `{}` → 必须 `resolve(JSObject)` 包装。
> 6. **标签名乱码**：SAF docId 是百分号编码，`path.split('/').pop()` 取到整个编码串 → 从目录树取权威名字 + decode 兜底。
> 7. **性能优化**：目录扫描每目录 3 查询→1 查询 + 顶层并行 4 线程；搜索两阶段 + 并行读文件 + 内容缓存（uri+mtime 键，32MB 上限）；读取改流式/分块 base64 降内存；目录 size 累计（修复安卓按大小排序）。

## 📱 手机验证（2026-08-22，Android Studio 模拟器 test_avd / Android 16 / x86_64 / 1080×2400 / 420dpi）

**结论：手机模式（主从视图）可用，返回键/旋转/搜索/会话恢复全部通过。**
（test_avd 在 `D:\Android\avd`，ANDROID_AVD_HOME 已设；启动命令见下。）

| 验证项 | 结果 |
|---|---|
| 手机模式判定 | viewport 412dp → body.phone-list / phone-reader；横屏 915dp → 自动回双栏 |
| 列表视图 | 文件树全屏（sidebar 412px），tabs/顶栏多余按钮隐藏，触摸目标 ≥44px |
| 阅读视图 | 正文全屏 + 顶栏「← + 文档名 + A−/A+ + ◐」，状态栏/标签栏隐藏 |
| 系统返回键 | 阅读→列表 ✓；列表→退出应用 ✓；下拉菜单打开时返回→关菜单不退出 ✓ |
| 历史栈 | 恒定 1 条（Kotlin 拦截方案，无 pushState 增长问题） |
| 会话恢复 | 重启自动恢复 SAF 根目录 + 上次文档 |
| SAF 全链路 | 授权/扫描/搜索/打开/阅读正常（与平板一致） |
| 搜索 | 列表视图内搜 "String" 命中 1 文件，点结果进阅读视图 ✓ |
| 横竖屏旋转 | 竖屏主从 ↔ 横屏双栏，视图状态保持（活动文档自动回阅读视图） |
| 字号/主题 | 阅读视图 A+/A− 与主题菜单可用（列表视图隐藏字号组） |

> 补充（2026-08-22 晚）：**Redmi 2510DRK44C 真机**（Android 16 / arm64-v8a / 1156×2510 / 480dpi，CSS 视口约 385dp）已安装同一 APK 验证：
> 手机模式布局正确（列表/空状态全屏、顶栏无溢出）、SAF 授权由人工在真机完成并确认可用、`__mdBack` 返回键回调就绪。
> 注：该机 uiautomator 桥不可用（null root node），真机 UI 自动化验证受限，交互细节以人工确认 + CDP 探测为准。

> 模拟器启动（本机 headless + 关 Vulkan 可避免卡死）：
> `D:\Android\Sdk\emulator\emulator.exe -avd test_avd -no-window -no-snapshot -no-audio -no-boot-anim -no-metrics -gpu swiftshader_indirect -feature -Vulkan`
> 前端验证走 WebView 远程调试：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + `node tests/cdp.mjs "<expr>"`

## 下一步（可继续验证的功能）

- 相对路径图片/链接（`resolveBytesBase64` / `resolveRelative`）——需要含图片的 md 实测。
- 搜索（文件名/内容）、主题切换、字号调节等纯前端功能。
- 若授权被撤销，重新点「打开文件夹」授权即可。
