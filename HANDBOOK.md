# 📘 项目状态与交接手册（给 AI 助手/开发者）· Project Status & Handover Handbook

> EN: This handbook records environment facts, pitfalls and design decisions that are invisible in the code.
> Read `BUILD.md` and `ANDROID_BUILD_STATUS.md` together for a seamless handover.
> 中文正文见下。

> **新开对话的 AI 请先读本文件 + `ANDROID_BUILD_STATUS.md` + `BUILD.md`**，即可无缝接手，无需重新摸索。
> 本文件记录的是"读代码看不出来的环境事实与历史决策"，是项目最关键的隐形知识。

## 1. 项目身份

- **应用名**：markdown阅读器（窗口标题/安卓应用名）
- **定位**：打开即预览的 Markdown 阅读器；Rust + Tauri 2；原生 TS 前端（无框架）；**Windows 桌面 + 安卓手机/平板**双平台
- **项目位置**：`C:\Users\aakb\Desktop\markdown 阅读器`（**注意：路径含中文+空格，很多工具链有坑，见下**）

## 2. 当前已实现功能（代码现状，2026-08-22）

- 打开文件夹 → 左侧递归文件树（自动跳过 .git/node_modules 等）
- 顶部标签页多文档，点击切换/关闭
- 打开即预览：基础语法 + 代码高亮（syntect 后端）+ KaTeX 公式 + Mermaid（按需懒加载）
- 本地图片（`mdimg://` 自定义协议）；md 间相对链接应用内打开（`mdopen://`）；http 链接系统浏览器打开
- 全文搜索（文件名+内容，Rust 后端，中文安全）
- 记忆：上次文件夹/文档/每文档滚动比例/主题/字号/排序（`%APPDATA%\com.chensdong.mdreader\session.json`）
- 目录自动监听刷新（notify 防抖 300ms）；正在阅读文档外部被改自动重渲染保持位置
- 主题：跟随系统 + 手动浅色/深色（**选择后立即落盘**）
- 字号 A−/A+（13–21px，CSS 变量 `--md-font-size`，立即落盘）
- 文件树排序下拉 6 种：名称A→Z/Z→A、修改时间(最新/最早)、大小(大→小/小→大)；**自然排序**（1.2.3…10.11）；**文件夹大小=子树文件总大小**；排序立即落盘
- 最近打开文件夹列表；侧栏可折叠；状态栏（文档/字数/阅读进度）
- 安卓：SAF 目录授权插件（新版 API），4 秒轻量轮询

## 3. 环境隐形知识（新 AI 最容易踩的坑）

| 事实 | 详情 |
|---|---|
| **MinGW 工具链** | 装在 `C:\Users\aakb\mingw64\mingw64\bin`（内含 `dlltool.exe`/`gcc.exe`）。已写入用户 PATH，**但新会话进程可能未继承**——跑任何 cargo 命令前先 `$env:Path = "$env:USERPROFILE\mingw64\mingw64\bin;$env:Path"` |
| **cargo target 目录重定向** | `.cargo/config.toml` 里 `[build] target-dir = "C:/mdrtarget"`。**原因**：项目路径含中文，MinGW 的 windres/cpp 把 UTF-8 路径读成乱码直接编译失败；ASCII target 目录保证 OUT_DIR 纯净。**不要改回项目内** |
| **图标在 C:\mdricons** | `tauri.conf.json` 的 `bundle.icon` 指向 `C:/mdricons/*`（同样为绕开中文路径 windres）。**删除会导致构建报错** |
| **cdylib 导出超限** | `.cargo/config.toml` 的 `[target.x86_64-pc-windows-gnu] rustflags = -Wl,--exclude-all-symbols`，修 "export ordinal too large" |
| **rustup 是 windows-gnu 工具链** | `rustup show` 默认 `x86_64-pc-windows-gnu`；没有 MSVC。别假设 cl.exe 存在 |
| **npm 源** | 项目根 `.npmrc` 指向 npmmirror（国内源） |
| **cargo 源** | 用户级 `~\.cargo\config.toml` 用 rsproxy.cn |
| **Android SDK/JDK** | `D:\Android\Sdk`（platform-36, build-tools 35/36, NDK 27.3.13750724）；`D:\Java\jdk-21.0.12+8`；环境变量 `ANDROID_HOME`/`JAVA_HOME` 已设 |
| **rustup 安卓目标** | 4 个（aarch64/armv7/i686/x86_64-linux-android）已装；离线包在 `C:\rustdist`（配 `RUSTUP_DIST_SERVER=file:///C:/rustdist` 可重装） |
| **cargo-ndk** | 已装 v4.1.2，但**手动运行报 "No chunk"**（NDK 版本检测问题）——tauri CLI 内部可用，别单独依赖 cargo-ndk |
| **本机网络走 fake-IP 代理**（2026-08-22 实测） | DNS 把 `github.com` 解析到 `198.18.0.52` / `fdfe:dcba:9876::33`（Clash 类 TUN 的保留段）。**git 的 HTTPS TLS 握手会被掐断**（schannel 报 "missing close_notify"、openssl 报 "unexpected eof"，重试无效）；`gh` CLI（Go HTTP 栈）不受影响。**git 操作必须走 SSH**：本项目 origin 已是 `git@github.com:tianmingwan/markdown-reader.git`，**勿改回 HTTPS** |
| **git 身份 / SSH 密钥** | 仓库本地 `user.name=tianmingwan`、`user.email=tianmingwan@users.noreply.github.com`；`~\.ssh\id_ed25519` 已注册到 GitHub（`ssh -T git@github.com` 可验证） |
| **gh CLI 已认证** | `gh auth status`：账号 `tianmingwan`，token 存系统 keyring（scope: repo/gist/read:org），建仓/发 Release 直接用 gh |

## 4. 桌面交付物（在桌面）

- `Markdown阅读器-安装程序.exe`（4MB，NSIS 安装包，含 WebView2Loader.dll）
- `markdown阅读器-安卓版.apk`（44.8MB，debug，4 ABI）
- `Markdown阅读器-便携版.zip`、`Markdown阅读器\` 文件夹（绿色版，exe+DLL 必须同目录）
- `阅读器.lnk`/`MarkdownReader.lnk`：已安装版本的快捷方式（旧版安装位置 `%LOCALAPPDATA%\MarkdownReader\`）
- 注意：桌面还有用户自己的 `opencode markdown阅读器\`、`markdown` 文件，**不是本项目的**

## 5. 用户数据（隐私，勿外泄）

- `%APPDATA%\com.chensdong.mdreader\session.json` —— 最近目录/文档/滚动比例/主题/字号/排序
- **当前值**：theme=`dark`、fontSize=`21`、sortMode=`null`（=名称A→Z）、lastRoot=考公资料目录
- 会话数据是用户真实使用痕迹，测试时勿随意覆盖（如需重置可先备份）

## 6. 构建命令

### 桌面
```powershell
$env:Path = "$env:USERPROFILE\mingw64\mingw64\bin;$env:Path"
cd "C:\Users\aakb\Desktop\markdown 阅读器"
npm install              # ⚠️ 2026-08-22 清理后 node_modules 已删，编译前必先装
npm run tauri dev        # 开发（vite + cargo）
npm run tauri build      # 安装包 → C:\mdrtarget\release\bundle\nsis\
npm test                 # 前端 Mermaid 深度测试 13 用例（jsdom + 真实 mermaid）
npm run test:rust        # Rust 核心测试 20 用例（等价 cargo test -p mdreader-core）
```
> 前端构建 `npm run build` 必须在**真实路径**跑（junction 会触发 vite 绝对路径 bug；已无 junction）。
> 原 `scripts/`（ui-test/sort-check）与 `test.html` 已删除（对安卓无用）；`vite.config.ts` 的 `server.fs.allow` 已处理 junction 兼容。
> ⚠️ `C:\mdrtarget` 已于 2026-08-22 清理删除：首次编译会**从头构建**（桌面 release 约 2-5 分钟，Android 4 ABI 约 10-20 分钟），之后增量编译正常。`src-tauri\target` 是重定向前遗留的 10GB debug 产物，已删，勿再生成。

### 安卓（关键：Windows 无开发者模式 → 必须绕过 tauri 的 symlink）
完整流程见 **`ANDROID_BUILD_STATUS.md`**。要点：
1. `npx tauri android build -t <abi>` 逐个编译 4 个 ABI（每次都会在 symlink 步骤失败退出，**属预期**，.so 已产出到 `C:\mdrtarget\<triple>\release\`）
2. 手动复制 .so → `gen\android\app\src\main\jniLibs\<abi>\libmdreader_lib.so`（映射见交接文档）
3. `$env:JAVA_HOME="D:\Java\jdk-21.0.12+8"; gen\android\gradlew.bat -p gen\android assembleDebug --no-daemon`
4. APK：`gen\android\app\build\outputs\apk\debug\app-debug.apk`
> gen/android 已被修改（禁用了 `id("rust")`、加了镜像/中文路径放行），**切勿重新 `tauri android init`**（会覆盖）。
> 若未来开了 Windows 开发者模式（需管理员），可直接 `tauri android build`。

## 7. 历史踩坑与修复记录（避免重复）

- **windres 中文路径崩溃** → ASCII target-dir + 图标移 C:\mdricons
- **cdylib export ordinal too large** → --exclude-all-symbols
- **WebView2Loader.dll 漏打包** → tauri.conf.json `bundle.resources` 加入（放 exe 同级，不能放子目录）
- **hidden 属性被 display:flex 覆盖**（空状态/主题菜单/loading 不消失）→ styles.css 全局 `[hidden]{display:none!important}`
- **中文内容搜索 panic**（字节切片越界）→ core/src/search.rs 字符边界安全截取
- **主题选择后不记忆**（800ms 防抖内关应用丢）→ 主题/字号/排序变更后立即 `session.flush()`
- **排序 1,10,2,3** → 自然排序（前后端一致）
- **"下一层没排序"** → 是"文件大小"排序模式造成的观感（文件夹 size 全 0），已改为文件夹 size=子树总大小 + 用户排序重置为名称A→Z
- **安卓插件 API** → tauri 2.11 新版（@TauriPlugin/@Command/@ActivityCallback + Rust 侧 register_android_plugin），旧 @JniMethod/Plugin(manager) 已废弃
- **Mermaid 重复图表 id 冲突** → mermaid.ts `rekeySvg` 必须覆盖 **4 种 id 形态**：`id="mmd-N"`、`id="mmd-N-xxx"`（破折号）、`id="mmd-N_xxx"`（**flowchart-v2 的 marker 用下划线**，漏掉会重复）、`<style>` 里的 `#mmd-N{...}` 选择器。mermaid 11 的 `render()` 内部排队串行 + 自动处理 `%%{init}%%`，无需并发池
- **勿在 globals.d.ts 声明 mermaid** → 曾写 `declare module 'mermaid' { const mermaid: any }`，把 mermaid 11 自带的完整类型遮蔽掉（TS 报 "no exported member 'Mermaid'"），已删除；mermaid 类型直接 `import type { Mermaid, MermaidConfig, RenderResult } from 'mermaid'`
- **jsdom 测 mermaid 三件套**（tests/mermaid.test.mjs）→ ① 全局补 `CSSStyleSheet`（否则 `createCssStyles` 报 "CSSStyleSheet is not defined"）；② `SVGElement.prototype.getBBox` polyfill **不能全零**（时序图 `calculateTextDimensions` 会报 "svg element not in render tree"），用 `{width:10,height:10}`；③ Node≥21 的 `globalThis.navigator` 是只读 getter，需 `Object.defineProperty` 覆盖
- **列表内 mermaid 缩进** → pulldown_cmark 对列表嵌套代码块**自动剥公共缩进**，`<pre class="mermaid">` 里是干净代码；前端 dedent 仅兜底其它场景

## 8. 代码结构速览

```
src\                前端（原生 TS，main.ts 入口）
  main.ts           主控/命令/字号/排序/会话恢复
  tree.ts           文件树渲染 + 排序下拉
  preview.ts        预览渲染（KaTeX 按需；Mermaid 委托 mermaid.ts）
  mermaid.ts        Mermaid 渲染：单次初始化 + SVG 缓存(源码×主题) + 逐图错误隔离 + id 重编号
  session.ts        会话持久化（前端）
  theme.ts / search.ts / api.ts / state.ts / types.ts / styles.css
src-tauri\          Rust 后端
  src\lib.rs        命令层/文件监听/入口
  src\img.rs        mdimg:// 图片协议
  src\saf\          SAF 插件（mobile.rs 新版 API / mod.rs 注册）
  core\src\         md.rs(渲染) tree.rs(扫描+自然排序+子树大小) search.rs session.rs（独立 crate，可单测）
  android-extras\   Kotlin SAF 插件源码（新版 API，拷入 gen 用）
  gen\android\      生成安卓工程（勿重新 init）
  .cargo\config.toml 构建修复
```

## 9. GitHub 发布与项目清理状态（2026-08-22 会话更新）

### 远程仓库（**公开**）

- **仓库**：https://github.com/tianmingwan/markdown-reader （PUBLIC，任何人可访问；内含隐私已扫描确认无敏感信息）
- **Releases**：`v0.1.0`（https://github.com/tianmingwan/markdown-reader/releases/tag/v0.1.0）
  - `MarkdownReader_0.1.0_x64-setup.exe`（Windows x64 NSIS，4.0MB）
  - `app-debug.apk`（Android debug，4 ABI，56.7MB）
- **推送方式**：`git push`（origin 是 SSH）；发新版：构建产物后 `gh release create v0.2.0 <安装包> <apk> --notes-file ...`
- **本地 git 状态**：main 分支 2 个提交（db3b789 初始 + 1e7f3e6 文档），工作区干净

### 项目清理（体积：10.4GB → 40.5MB）

2026-08-22 会话应要求删除全部可再生构建产物，**只保留源码 + 未来编译必需**：
- 已删：`src-tauri\target`（10GB 旧 debug）、`C:\mdrtarget`（8GB cargo 目录）、`node_modules`、`dist`、`gen\android\app\build`、`gen\android\.gradle`、`gen\android\app\src\main\assets`
- 保留：全部源码、`gen\android` 工程文件（含手动修改）、`WebView2Loader.dll`、`.git`、文档
- **影响**：未来编译先 `npm install`；`C:\mdrtarget` 会自动重建（首轮全量编译）

### 文档重命名对照（若在旧对话/旧记录里看到旧名）

| 旧文件名 | 新文件名 |
|---|---|
| 使用与构建说明.md | **BUILD.md** |
| 项目状态与交接手册.md | **HANDBOOK.md** |
| 性能优化研究报告.md | **PERFORMANCE.md** |
