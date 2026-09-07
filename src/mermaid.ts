/**
 * Mermaid 流程图渲染模块 —— 按需懒加载 + 渲染结果缓存 + 逐图错误隔离。
 *
 * 相比「每次渲染都 initialize + run」的朴素用法，这里做了四点性能 / 健壮性优化：
 *
 * 1. `import('mermaid')` 只在文档确实包含流程图时触发（Vite 拆成独立 chunk，未用到不下载）；
 * 2. `mermaid.initialize()` 每个主题只执行一次（切主题时才重新初始化），
 *    避免快速切换标签页时并发 initialize 的竞态，也省去每次渲染重置单例的开销；
 * 3. 渲染结果按 (源码, 主题) 缓存 —— 重复渲染（切标签、文件热更新、主题切换）
 *    直接复用 SVG；插入时对 SVG 内部的 id 重新编号，保证同一文档里出现重复图表
 *    也不会产生 id / marker url 冲突；
 * 4. 每个图表独立 try/catch：单个语法错误不影响其它图表，并渲染可见的错误占位。
 *
 * 说明：mermaid 官方 API 已保证多次 render() 内部排队串行执行，因此这里按序
 * 逐图渲染即可，无需自建并发池；`%%{init: ...}%%` 等每图指令由 render() 内部
 * 自动处理（reset 只清指令栈、保留 initialize 设置的全局配置）。
 */

import type { Mermaid, MermaidConfig, RenderResult } from 'mermaid';

export type MermaidTheme = 'light' | 'dark';

let mermaidPromise: Promise<Mermaid> | null = null;

function ensureMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => (m as { default: Mermaid }).default);
  }
  return mermaidPromise;
}

// ---------------- 全局初始化（每个主题一次） ----------------
let initDoneFor: MermaidTheme | null = null;
let initPromise: Promise<void> | null = null;

function ensureInit(theme: MermaidTheme): Promise<void> {
  if (initPromise && initDoneFor === theme) return initPromise;
  initPromise = ensureMermaid().then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      securityLevel: 'loose',
      fontFamily: 'inherit',
    } satisfies MermaidConfig);
    initDoneFor = theme;
  });
  return initPromise;
}

// ---------------- SVG 结果缓存 ----------------
interface CachedDiagram {
  /** 渲染出的 SVG（内部 id 均以 renderId 为前缀） */
  svg: string;
  /** 渲染时使用的 id 前缀 */
  renderId: string;
  /** 事件绑定函数（tooltip / click），插入后需在新元素上再执行一次 */
  bindFunctions?: RenderResult['bindFunctions'];
}

const cache = new Map<string, CachedDiagram>();
/** 缓存上限：48 张图，按 FIFO 淘汰（Map 保持插入顺序） */
const CACHE_LIMIT = 48;

function cacheKey(code: string, theme: MermaidTheme): string {
  return (theme === 'dark' ? 'd' : 'l') + '\u0000' + code;
}

function setCached(key: string, entry: CachedDiagram): void {
  cache.set(key, entry);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// ---------------- 工具 ----------------
let idCounter = 0;
function nextId(): string {
  return `mmd-${++idCounter}`;
}

/** 去掉所有非空行的公共前导空白（与 mermaid 内部 dedent 行为一致，兼容列表内缩进代码块） */
function dedent(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!Number.isFinite(min) || min === 0) return text;
  return lines.map((l) => l.slice(min)).join('\n');
}

/**
 * 把 SVG 里的 id 前缀从 oldId 换成 newId，避免同一文档中重复图表产生重复 id /
 * marker url 引用冲突。mermaid 生成的 id 形态有四种，全部覆盖：
 *   id="mmd-3"（根 svg）、id="mmd-3-xxx"（节点/边，破折号）、
 *   id="mmd-3_xxx"（flowchart-v2 marker，下划线）、<style> 里的 #mmd-3 选择器。
 * 前缀后必须紧跟 `"` / `-` / `_` / 非 id 字符，因此不会误伤 mmd-30 之类的其它 id。
 */
function rekeySvg(svg: string, oldId: string, newId: string): string {
  if (oldId === newId) return svg;
  const esc = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = svg
    .replace(new RegExp(`id="${esc}"`, 'g'), `id="${newId}"`)
    .replace(new RegExp(`id="${esc}-`, 'g'), `id="${newId}-`)
    .replace(new RegExp(`id="${esc}_`, 'g'), `id="${newId}_`)
    .replace(new RegExp(`url\\(#${esc}-`, 'g'), `url(#${newId}-`)
    .replace(new RegExp(`url\\(#${esc}_`, 'g'), `url(#${newId}_`)
    .replace(new RegExp(`url\\(#${esc}\\)`, 'g'), `url(#${newId})`)
    // style 选择器 #mmd-3{ / #mmd-3 .x{ ……；后跟 id 字符的不动（mmd-30）
    .replace(new RegExp(`#${esc}(?![A-Za-z0-9_-])`, 'g'), `#${newId}`);
  return out;
}

// ---------------- DOM 写入 ----------------
/**
 * 把渲染结果写入文档。rekey=true 时把 SVG 内部 id 重新编号为全新前缀
 * （缓存复用路径：保证同一文档里重复图表不产生 id 冲突）；
 * rekey=false 时保留原始 id（首次渲染路径：让 flowchart 的 click 回调能按 id 命中）。
 */
function applyCached(node: HTMLElement, entry: CachedDiagram, rekey: boolean, rawCode?: string): void {
  const div = document.createElement('div');
  div.className = 'mermaid';
  if (rawCode) div.dataset.raw = rawCode;
  div.innerHTML = rekey ? rekeySvg(entry.svg, entry.renderId, nextId()) : entry.svg;
  entry.bindFunctions?.(div); // tooltip 等按 class 选择器绑定，与 id 重编号无关
  node.replaceWith(div);
}

function replaceError(node: HTMLElement, code: string, message: string): void {
  const div = document.createElement('div');
  div.className = 'mermaid-error';

  const title = document.createElement('div');
  title.className = 'mermaid-error-title';
  title.textContent = '⚠ 流程图渲染失败';

  const msg = document.createElement('div');
  msg.className = 'mermaid-error-msg';
  msg.textContent = message;

  const pre = document.createElement('pre');
  pre.className = 'mermaid-error-code';
  pre.textContent = code || '（空图表）';

  div.append(title, msg, pre);
  node.replaceWith(div);
}

// ---------------- 渲染入口 ----------------
/**
 * 渲染 container 内所有 `pre.mermaid`，就地替换为渲染好的 SVG（div.mermaid）。
 * 命中缓存的直接复用；失败的单图显示错误占位，不影响其它图表。
 * 异步期间若节点已脱离文档（如快速切换标签页），自动跳过。
 */
export async function renderMermaidIn(container: HTMLElement, theme: MermaidTheme): Promise<void> {
  const nodes = Array.from(container.querySelectorAll<HTMLPreElement>('pre.mermaid'));
  if (nodes.length === 0) return;

  let mermaid: Mermaid;
  try {
    await ensureInit(theme);
    mermaid = await ensureMermaid();
  } catch (e) {
    console.warn('[mermaid] 初始化失败，跳过流程图渲染', e);
    return;
  }

  for (const node of nodes) {
    if (!node.isConnected || !container.contains(node)) continue; // 标签已切换，节点被替换

    const code = dedent(node.textContent ?? '').trim();
    if (code === '') {
      replaceError(node, '', '空图表');
      continue;
    }

    const key = cacheKey(code, theme);
    const hit = cache.get(key);
    if (hit) {
      applyCached(node, hit, true, code); // 复用缓存：重编号，避免同文档重复图表 id 冲突
      continue;
    }

    try {
      const renderId = nextId();
      const { svg, bindFunctions } = await mermaid.render(renderId, code, node);
      const entry: CachedDiagram = { svg, renderId, bindFunctions };
      setCached(key, entry);
      applyCached(node, entry, false, code); // 首次渲染：保留原始 id，click 回调可命中
    } catch (e) {
      console.warn('[mermaid] 图表渲染失败', e);
      replaceError(node, code, e instanceof Error ? e.message : String(e));
    }
  }
}

// ---------------- 测试 / 诊断钩子（生产代码不依赖这些导出） ----------------
export const __internals = {
  dedent,
  rekeySvg,
  cacheKey,
  setCached,
  cacheSize: (): number => cache.size,
  cacheKeys: (): string[] => Array.from(cache.keys()),
  cacheClear: (): void => cache.clear(),
};
