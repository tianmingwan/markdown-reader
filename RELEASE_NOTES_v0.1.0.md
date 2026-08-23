# Markdown Reader v0.1.0

打开即预览的 Markdown 阅读器（Rust + Tauri 2）· Open-and-preview Markdown reader (Rust + Tauri 2)

## 📦 下载 / Download

| 平台 Platform | 文件 Asset | 说明 Notes |
|---|---|---|
| Windows (x64) | `MarkdownReader_0.1.0_x64-setup.exe` | NSIS 安装包，Windows 10/11 |
| Android | `app-debug.apk` | debug 构建，含 arm64/arm/x86/x86_64 四 ABI，Android 8+ |

## ✨ 特性 / Features

- 打开文件夹即预览（打开即预览），多标签 + 阅读位置记忆
- md→HTML 全 Rust 后端渲染（pulldown-cmark + syntect 代码高亮）
- KaTeX 公式、Mermaid 流程图/时序图按需加载（Mermaid：SVG 缓存 + 逐图错误隔离 + 重复图表 id 去重）
- 全文搜索（文件名 + 内容）、文件热更新、浅色/深色/跟随系统主题
- 跨平台：Windows 桌面 + 安卓手机/平板（SAF 目录授权）

## 🔧 测试 / Tests

- 前端 Mermaid 渲染管线深度测试 13 用例（jsdom + 真实 mermaid）：`npm test`
- Rust 核心测试 20 用例：`npm run test:rust`

## ⚠️ 说明 / Notes

- APK 为 **debug 构建**：可正常安装使用（体积较大 ~60MB，含 4 个 ABI）；正式发布可用 release 构建 + 签名。
- Windows 安装包为 NSIS 安装器，安装后从开始菜单启动「MarkdownReader」。
- 项目源码与文档见仓库根目录：`README.md`（双语）、`BUILD.md`、`HANDBOOK.md`、`PERFORMANCE.md`、`ANDROID_BUILD_STATUS.md`。
