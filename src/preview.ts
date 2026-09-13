import type { RootRef, Tab } from './types';
import { state } from './state';
import { api } from './api';
import { recordPosition } from './session';
import { renderMermaidIn } from './mermaid';
import { CHUNK_TARGET, PROGRESSIVE_THRESHOLD, splitHtmlChunks } from './chunker';

// KaTeX 按需懒加载（只加载一份，后续复用）；Mermaid 见 mermaid.ts
let katexPromise: Promise<{ render: typeof import('katex').default; autoRender: any }> | null = null;

async function ensureKatex(): Promise<{ render: typeof import('katex').default; autoRender: any }> {
  if (!katexPromise) {
    // 动态 import：Vite 会切成独立 chunk，仅在文档含公式时加载
    katexPromise = Promise.all([
      import('katex'),
      import('katex/contrib/auto-render'),
      // 样式与字体随 chunk 一起按需注入
      import('katex/dist/katex.min.css'),
    ]).then(([katexMod, autoRenderMod]) => ({
      render: (katexMod as any).default ?? katexMod,
      autoRender: (autoRenderMod as any).default ?? autoRenderMod,
    }));
  }
  return katexPromise;
}

export interface PreviewHandlers {
  onOpenFile: (path: string, fragment?: string) => void;
}

/** 进行中的渐进式分块渲染所用的动画帧句柄（0 表示没有） */
let pendingChunkRaf = 0;
/** 渲染代号：新渲染开始时递增，旧渲染据此放弃尚未插完的分块 */
let renderGeneration = 0;

/** 检测是否位于无法测量宽度的隐藏容器中（例如手机列表视图下的预览区） */
function isUnmeasurable(el: HTMLElement): boolean {
  try {
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' || cs.contentVisibility === 'hidden';
  } catch {
    return false;
  }
}

/**
 * 把 tab 渲染进预览区。
 *
 * 大文档走「渐进式分块渲染」：首块同步插入让首屏立即可见，其余块在后续动画帧里
 * 逐块追加，主线程始终有喘息机会。返回的 Promise 在全部块插入后 resolve。
 */
export async function renderPreview(article: HTMLElement, tab: Tab, dark: boolean, handlers: PreviewHandlers): Promise<void> {
  // 内容写入居中的 .preview-content；article 只负责整宽滚动
  const content = (article.querySelector('#preview-content') as HTMLElement | null) ?? article;

  // 切换文档 / 切换主题时，取消上一轮尚未插完的分块
  if (pendingChunkRaf) {
    cancelAnimationFrame(pendingChunkRaf);
    pendingChunkRaf = 0;
  }

  // 每次渲染 +1；若渲染期间又发起了新渲染（切文档/切主题），本轮立即放弃补齐
  const myRender = ++renderGeneration;

  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tooBig = tab.html.length > PROGRESSIVE_THRESHOLD;
  // 手机列表视图下预览区 display:none，同步插入不会产生布局成本，无需分块
  const progressive = tooBig && !reduceMotion && !isUnmeasurable(content);

  if (progressive) {
    const chunks = splitHtmlChunks(tab.html);
    // ① 首块同步插入 → 首屏很快可见
    content.innerHTML = chunks[0];
    // ② 其余块逐帧追加；每块后主动布局，把排版成本放在受控时机
    for (let i = 1; i < chunks.length; i++) {
      if (myRender !== renderGeneration) return; // 已被新渲染取代，放弃补齐
      await new Promise<void>((resolve) => {
        pendingChunkRaf = requestAnimationFrame(() => {
          pendingChunkRaf = 0;
          content.insertAdjacentHTML('beforeend', chunks[i]);
          void content.offsetHeight; // 必须主动布局，否则滚动时集中补算导致严重掉帧
          resolve();
        });
      });
    }
    if (myRender !== renderGeneration) return;
  } else {
    content.innerHTML = tab.html;
  }

  attachClickHandlers(content, handlers);

  const tasks: Promise<void>[] = [];

  if (tab.hasMath) {
    tasks.push(
      (async () => {
        try {
          const { render, autoRender } = await ensureKatex();
          autoRender(content, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '$', right: '$', display: false },
            ],
            throwOnError: false,
            strict: false,
          });
          void render;
        } catch (e) {
          console.warn('KaTeX 渲染失败', e);
        }
      })(),
    );
  }

  if (tab.hasMermaid) {
    tasks.push(
      (async () => {
        try {
          await renderMermaidIn(content, dark ? 'dark' : 'light');
        } catch (e) {
          console.warn('Mermaid 渲染失败', e);
        }
      })(),
    );
  }

  await Promise.all(tasks);
}

/** 恢复滚动位置（比例） */
export function restoreScroll(article: HTMLElement, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    article.scrollTop = 0;
    return;
  }
  const max = article.scrollHeight - article.clientHeight;
  article.scrollTop = max > 0 ? ratio * max : article.scrollTop;
}

/** 预览区滚动监听：记录比例 + 持久化 */
export function attachScrollListener(
  article: HTMLElement,
  getRoot: () => RootRef | null,
  getPath: () => string | null,
  onRatio: (ratio: number) => void,
): void {
  let raf = 0;
  article.addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const root = getRoot();
        const path = getPath();
        if (!root || !path) return;
        const max = article.scrollHeight - article.clientHeight;
        const ratio = max > 0 ? article.scrollTop / max : 0;
        recordPosition(root, path, ratio);
        onRatio(ratio);
      });
    },
    { passive: true },
  );
}

/** 当前预览区正在使用的交互回调（点击监听只挂一次，避免重复渲染时监听器累积） */
let activeHandlers: PreviewHandlers | null = null;
let clickBound = false;

function attachClickHandlers(article: HTMLElement, handlers: PreviewHandlers): void {
  // 回调可能随调用点变化，每次渲染只更新引用
  activeHandlers = handlers;
  if (clickBound) return;
  clickBound = true;
  article.addEventListener('click', async (e) => {
    const target = (e.target as HTMLElement).closest('a');
    if (!target) return;
    const href = target.getAttribute('href') ?? '';

    if (href.startsWith('mdopen://')) {
      e.preventDefault();
      let path = '';
      let fragment = '';
      const hashIdx = href.indexOf('#');
      const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
      if (hashIdx >= 0) fragment = href.slice(hashIdx + 1);

      if (pathPart.startsWith('mdopen://local/')) {
        path = decodeURIComponent(pathPart.slice('mdopen://local/'.length));
      } else if (pathPart.startsWith('mdopen://mobile/')) {
        try {
          const rest = pathPart.slice('mdopen://mobile/'.length);
          const sep = rest.indexOf('/');
          if (sep < 0) return;
          const ctx = decodeURIComponent(rest.slice(0, sep));
          const rel = decodeURIComponent(rest.slice(sep + 1));
          path = await api.resolveRel(ctx, rel);
        } catch (err) {
          console.warn('相对链接解析失败', err);
          return;
        }
      }
      if (path) activeHandlers?.onOpenFile(path, fragment || undefined);
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      e.preventDefault();
      void api.openExternal(href);
    }
    // 其它（#锚点、mailto 等）走默认行为
  });
}

export function decodeMdimgLocal(pathPart: string): string {
  return decodeURIComponent(pathPart.slice('mdimg://local/'.length));
}

export function currentTab(): Tab | null {
  return state.tabs.find((t) => t.path === state.activePath) ?? null;
}