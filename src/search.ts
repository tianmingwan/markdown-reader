import { api } from './api';
import { state } from './state';
import type { SearchHit } from './types';

let timer: number | undefined;

export function setupSearch(
  input: HTMLInputElement,
  clearBtn: HTMLElement,
  resultsPanel: HTMLElement,
  treePanel: HTMLElement,
  onOpenFile: (path: string) => void,
): void {
  const run = (): void => {
    const q = input.value.trim();
    clearBtn.hidden = q.length === 0;

    if (!q) {
      treePanel.hidden = false;
      resultsPanel.hidden = true;
      return;
    }
    void doSearch(q, resultsPanel, treePanel, onOpenFile);
  };

  input.addEventListener('input', () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(run, 250); // 防抖
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      run();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    run();
    input.focus();
  });
}

async function doSearch(
  q: string,
  resultsPanel: HTMLElement,
  treePanel: HTMLElement,
  onOpenFile: (path: string) => void,
): Promise<void> {
  const root = state.root;
  if (!root) return;
  treePanel.hidden = true;
  resultsPanel.hidden = false;
  resultsPanel.textContent = '';
  resultsPanel.appendChild(loadingEl());

  const seq = ++state.searchSeq;
  let hits: SearchHit[] = [];
  try {
    hits = await api.search(root.loc, q);
  } catch {
    hits = [];
  }
  if (seq !== state.searchSeq) return; // 丢弃过期结果

  resultsPanel.textContent = '';
  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = '未找到匹配的文件';
    resultsPanel.appendChild(empty);
    return;
  }

  const title = document.createElement('div');
  title.className = 'search-title';
  title.textContent = `“${q}” 找到 ${hits.length} 个文件`;
  resultsPanel.appendChild(title);

  // 性能：只渲染前 100 条
  for (const hit of hits.slice(0, 100)) {
    resultsPanel.appendChild(renderHit(hit, root.loc, q, onOpenFile));
  }
}

function loadingEl(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'search-loading';
  el.textContent = '搜索中…';
  return el;
}

function renderHit(hit: SearchHit, rootLoc: string, q: string, onOpenFile: (path: string) => void): HTMLElement {
  const item = document.createElement('div');
  item.className = 'search-hit';
  item.title = hit.path;

  const head = document.createElement('div');
  head.className = 'search-hit-head';
  const icon = document.createElement('span');
  icon.className = 'search-hit-icon';
  icon.textContent = hit.matchedBy === 'name' ? '🔤' : '🔍';
  const name = document.createElement('span');
  name.className = 'search-hit-name';
  name.textContent = hit.name;
  head.append(icon, name);
  item.appendChild(head);

  // 相对根目录的路径
  let rel = hit.path;
  if (rootLoc && rel.startsWith(rootLoc)) rel = rel.slice(rootLoc.length);
  rel = rel.replace(/^[/\\]+/, '');
  const dir = document.createElement('div');
  dir.className = 'search-hit-dir';
  dir.textContent = rel;
  item.appendChild(dir);

  for (const s of hit.snippets) {
    const snip = document.createElement('div');
    snip.className = 'search-hit-snippet';
    snip.appendChild(highlight(s, q));
    item.appendChild(snip);
  }

  item.addEventListener('click', () => onOpenFile(hit.path));
  return item;
}

/** 转义后高亮匹配词 */
function highlight(text: string, q: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  let idx = 0;
  let from = 0;
  while ((idx = lower.indexOf(lowerQ, from)) >= 0) {
    frag.appendChild(document.createTextNode(text.slice(from, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + q.length);
    frag.appendChild(mark);
    from = idx + q.length;
  }
  frag.appendChild(document.createTextNode(text.slice(from)));
  return frag;
}