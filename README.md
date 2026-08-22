# Markdown Reader · markdown阅读器

> **打开即预览的 Markdown 阅读器** — An open-and-preview Markdown reader.
> **Rust + Tauri 2** · Windows 桌面 + 安卓平板（同一套代码）· Windows desktop & Android tablet from one codebase.

## ✨ 特性 / Features

| 中文 | English |
| --- | --- |
| 打开文件夹即预览，无需编辑/保存 | Open a folder and preview instantly — no editor, no save |
| 多标签页，自动记忆阅读位置 | Multi-tabs with remembered scroll position |
| md→HTML 全部在 Rust 后端渲染（pulldown-cmark + syntect 高亮） | Markdown → HTML fully rendered in Rust (pulldown-cmark + syntect highlight) |
| KaTeX 公式按需加载 | KaTeX math loaded on demand |
| **Mermaid 流程图/时序图等按需加载**（缓存 + 逐图错误隔离） | **Mermaid diagrams loaded on demand** (SVG cache + per-diagram error isolation) |
| 全文搜索（文件名 + 内容） | Full-text search (filenames + content) |
| 文件变化自动刷新预览 | Auto-refresh preview on file changes |
| 主题：浅色 / 深色 / 跟随系统 | Themes: light / dark / system |
| 安卓 SAF 目录授权 | Android SAF folder access |

## 🚀 快速开始 / Quick Start

```bash
npm install          # 安装前端依赖 / install frontend deps
npm run tauri dev    # 桌面端开发运行 / run desktop dev build
```

- **自带演示**：打开「示例文档」文件夹体验全部功能（含 Mermaid 流程图示例）。
  Open the `示例文档` folder to try every feature, including Mermaid flowcharts.
- 界面预览 / UI sketch：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ☰ 打开文件夹…   🔍 搜索文件名/内容…          ◐主题 ▾最近   ─ □ ✕          │
├──────────────┬───────────────────────────────────────────────────────────┤
│ 📁 示例文档    │ [ README.md ✕ ] [ 方案.md ✕ ]                            │
│ ├─ 📁 工作    │════════════════════════════════════════════════════════  │
│ │   └ 📄 方案.md│  # 方案：markdown 阅读器                                 │
│ ├─ 📁 学习    │                                                          │
│ │   └ 📄 笔记.md│  渲染中的预览（代码高亮/公式/图表/图片/表格）              │
│ └─ 📁 日记    │                                                          │
│     └ 📄 2026.…│                                                          │
├──────────────┴───────────────────────────────────────────────────────────┤
│ 📁 示例文档 · 4 个 md ｜ 正在阅读: 方案.md ｜ 1.2 KB ｜ 345 字 ｜ 已读到 42%│
└──────────────────────────────────────────────────────────────────────────┘
```

## 🧪 测试 / Tests

```bash
npm test             # 前端 Mermaid 渲染管线深度测试（jsdom + 真实 mermaid）
npm run test:rust    # Rust 核心测试（渲染/搜索/树/会话，含 mermaid 检测）
```

## 🛠 技术栈 / Tech Stack

- **前端**：原生 TypeScript + Vite（无框架），KaTeX / Mermaid 动态分块懒加载
- **后端**：Rust · Tauri 2 · pulldown-cmark · syntect · notify-debouncer-mini
- **核心 crate**：`mdreader-core`（渲染/搜索/树/会话，独立可单测）

## 📚 文档 / Docs

| 文件 / File | 内容 / Content |
| --- | --- |
| [BUILD.md](BUILD.md) | 构建与使用说明 / Build & usage guide（中文） |
| [HANDBOOK.md](HANDBOOK.md) | 项目状态与交接手册（环境事实/踩坑/结构） / Status & handover handbook（中文） |
| [PERFORMANCE.md](PERFORMANCE.md) | 性能优化研究报告 / Performance report（中文） |
| [ANDROID_BUILD_STATUS.md](ANDROID_BUILD_STATUS.md) | 安卓 APK 构建交接 / Android APK build status（中文） |

## 📄 License

未指定 / Not specified（私有项目 / private repository）。
