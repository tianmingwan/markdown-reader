// 模块声明：katex contrib 无内置类型
declare module 'katex/contrib/auto-render';
declare module 'katex/dist/katex.min.css';
// 注意：mermaid 11 自带完整类型（dist/mermaid.d.ts），不要再声明 ambient module，
// 否则会遮蔽其具名导出（Mermaid / MermaidConfig / RenderResult 等）。
