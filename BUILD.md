# markdown阅读器 · Markdown Reader

> EN: Build & usage guide for the Markdown Reader (Rust + Tauri 2, Windows desktop & Android phones/tablets).
> 中文正文见下。

打开即预览的 Markdown 阅读器 —— **Rust + Tauri 2**，支持 **Windows 桌面** 与 **安卓手机/平板**（同一套代码）。

## ✨ 功能

| 功能 | 说明 |
| --- | --- |
| 打开即预览 | 打开文件夹 → 左侧文件树 → 点击任意 md 立即预览 |
| 顶部标签页 | 多个文档同时打开，随时切换 / 关闭 |
| 左侧文件树 | 递归显示下属文件夹与全部 .md（自动跳过 .git、node_modules 等噪音目录） |
| 全文搜索 | 顶部搜索框：按文件名 + 文件内容查找，点击结果直接打开 |
| 渲染能力 | 基础语法 + 代码高亮（Rust 后端 syntect）+ KaTeX 公式 + Mermaid 图（按需加载） |
| 本地图片 | md 中相对路径图片直接显示（`mdimg://` 自定义协议） |
| 记忆功能 | 打开即回到上次的文件夹、文档、滚动位置 |
| 自动刷新 | 目录文件增删改自动更新侧边栏；正在阅读的文档外部被改自动重渲染并保持阅读位置 |
| 最近打开 | 顶栏「▾ 最近」列出最近文件夹，一键重进 |
| 主题 | 跟随系统 + 手动切换浅色/深色（切换后所有打开的文档立即换肤） |
| 站内链接 | md 之间相对链接点击在应用内新标签打开；http(s) 链接用系统浏览器打开 |

## 🚀 性能设计

- **渲染全在后端**：md → HTML（含代码高亮）在 Rust 中完成，毫秒级；前端无框架（原生 TS），主包仅约 20KB。
- **重资源按需加载**：KaTeX / Mermaid 切成独立 chunk，只有文档里出现 `$公式$` 或 ```` ```mermaid ```` 才加载；普通文档秒开、内存占用低。
- **目录扫描后台化**：扫描在后台线程执行；监听用 notify 防抖 300ms 增量更新。
- **不打包浏览器内核**：桌面用系统 WebView2，安卓用系统 WebView，安装包小、资源占用低。

## 🖥️ 桌面端运行

环境要求（本机已配好）：Rust（stable windows-gnu）+ MinGW-w64（`%USERPROFILE%\mingw64`，已写入用户 PATH）+ Node ≥18。

```powershell
cd "C:\Users\aakb\Desktop\markdown 阅读器"
npm install          # 前端依赖（已装好）
npm run tauri dev    # 开发模式：编译 + 启动 + 前端热更新
```

生成安装包：

```powershell
npm run tauri build   # 产出 NSIS 安装器 → src-tauri\target\release\bundle\nsis\
```

> ✅ 本仓库已内置两个构建修复（`src-tauri\.cargo\config.toml` + `tauri.conf.json`）：
> 1. **中文/空格路径**：MinGW 的 windres/cpp 无法处理非 ASCII 路径，
>    已把 cargo target 目录固定为 `C:\mdrtarget`（ASCII），图标也放在 `C:\mdricons`，
>    因此项目放在任何路径（含中文/空格）都能直接构建，无需额外操作。
> 2. **export ordinal too large**：windows-gnu 下 cdylib 导出符号超限，已加
>    `-Wl,--exclude-all-symbols` 自动处理。
>
> 若日后改用 MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`），
> 这些限制自动消失，也可删掉上述配置。

调试辅助：启动时自动打开指定文件夹（冒烟测试用）：

```powershell
$env:MDREADER_DEV_FOLDER = "C:\Users\aakb\Desktop\markdown 阅读器\示例文档"
npm run tauri dev
```

## 🧪 测试

```powershell
cd "C:\Users\aakb\Desktop\markdown 阅读器\src-tauri"
cargo test -p mdreader-core   # 11 个单元测试：渲染/高亮/扫描/搜索/会话
```

核心逻辑全部在独立 crate `mdreader-core`（不依赖 Tauri），测试可在任何环境运行。

## 🤖 安卓（SAF 方式）

安卓系统不允许像电脑一样任意选择文件夹，阅读器采用 **SAF（Storage Access Framework）**：
点「打开文件夹」→ 系统文件选择器授权一个目录树 → 授权后即可浏览其下全部 md（授权持久化，下次启动无需重选）。
安卓端目录变化靠**轻量轮询**（每 4 秒、仅前台时进行；SAF 不支持文件监听）。

### 首次构建安卓版（一次性准备）

1. 安装 **JDK 17**（如 Temurin），设置 `JAVA_HOME`。
2. 安装 **Android Studio**（或 cmdline-tools）+ SDK Platform 34 + Build-Tools 34 + NDK 27，设置 `ANDROID_HOME`。
3. `cargo install cargo-ndk`
4. 初始化安卓工程并注册 SAF 插件：

```powershell
cd "C:\Users\aakb\Desktop\markdown 阅读器"
npm run tauri android init

# ① 拷贝 SAF 插件 Kotlin 代码到生成工程（**包名必须是 com.chensdong.mdreader**，
#    与 Rust 侧 register_android_plugin("com.chensdong.mdreader", "SafPlugin") 一致；
#    拷错包名会导致启动时 ClassNotFoundException 崩溃）：
Copy-Item src-tauri\android-extras\SafPlugin.kt src-tauri\gen\android\app\src\main\java\com\chensdong\mdreader\SafPlugin.kt -Force

# ② 拷贝手机支持版 MainActivity（返回键拦截 + debug WebView 调试；覆盖生成工程的同名文件）：
Copy-Item src-tauri\android-extras\MainActivity.kt src-tauri\gen\android\app\src\main\java\com\chensdong\mdreader\MainActivity.kt -Force

# ③ 新版 tauri-android 用 @TauriPlugin 注解 + register_android_plugin 自动实例化，
#    无需修改 MainActivity 注册插件。
```

### 构建 APK

> ⚠️ 本机（`C:\Users\aakb\Desktop\markdown 阅读器`）因 Windows 未开开发者模式，
> `npm run tauri android build` 会在 symlink 步骤失败，**必须**按
> `ANDROID_BUILD_STATUS.md` 里的绕过流程走（手动拷 .so + gradle 直接打包）。
> 直接 gradle 打包时，**还要手动把前端资源拷进 assets**（tauri CLI 才会自动拷）：

```powershell
Copy-Item dist\* src-tauri\gen\android\app\src\main\assets\ -Recurse -Force
Copy-Item src-tauri\tauri.conf.json src-tauri\gen\android\app\src\main\assets\ -Force
```

正常环境（开发者模式可用）直接：

```powershell
npm run tauri android build   # → gen\android\app\build\outputs\apk\debug\app-debug.apk
```

传到手机/平板安装，或连接设备后 `npm run tauri android dev` 热更新调试。

> ✅ 本机 Android SDK（`D:\Android\Sdk`）、JDK（`D:\Java\jdk-21.0.12+8`）、NDK 27 均已就绪；
> Rust 桥接（`src-tauri/src/saf/`）与 Kotlin 插件（`src-tauri/android-extras/SafPlugin.kt`，包名
> `com.chensdong.mdreader`）已写好，APK 已在平板真机（TB371FC）实测可运行。

### 安卓端说明

- 相对路径图片/链接：按 md 所在目录在 SAF 树中逐段解析（支持子目录与 `..`）。
- 大目录首次扫描可能稍慢（SAF 逐目录查询），之后轮询只跑元数据。
- 授权被撤销时重新点「打开文件夹」授权即可。

## 📁 目录结构

```
├─ index.html / src/           前端（原生 TS；src/main.ts 入口）
├─ src-tauri/
│  ├─ src/lib.rs               Tauri 命令、文件监听、入口
│  ├─ src/img.rs               mdimg:// 图片协议
│  ├─ src/saf/                 安卓 SAF 桥（mobile 为 Kotlin 调用）
│  ├─ android-extras/          安卓 Kotlin 插件源码
│  ├─ core/                    核心逻辑 crate（md 渲染/树扫描/搜索/会话）
│  └─ .cargo/config.toml       构建修复（ASCII target 目录、导出符号限制）
├─ dist/                       前端产物（npm run build 生成）
└─ 示例文档/                   自带演示：高亮/公式/Mermaid/图片/表格/站内链接
```

## 🗂️ 会话数据

存于 `%APPDATA%\com.chensdong.mdreader\session.json`：最近文件夹、上次文档、
每篇文档的滚动比例（键 = 目录|文件）、主题。删除该文件即恢复出厂状态。