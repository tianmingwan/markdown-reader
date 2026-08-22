import type { RootRef, Tab } from './types';
import { state } from './state';
import { api } from './api';
import { recordPosition } from './session';
import { renderMermaidIn } from './mermaid';

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

/** 把 tab 渲染进预览区；返回恢复滚动位置的函数（异步加载完后需再次调用） */
export async function renderPreview(article: HTMLElement, tab: Tab, dark: boolean, handlers: PreviewHandlers): Promise<void> {
  // 内容写入居中的 .preview-content；article 只负责整宽滚动
  const content = (article.querySelector('#preview-content') as HTMLElement | null) ?? article;
  content.innerHTML = tab.html;
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

function attachClickHandlers(article: HTMLElement, handlers: PreviewHandlers): void {
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
      if (path) handlers.onOpenFile(path, fragment || undefined);
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