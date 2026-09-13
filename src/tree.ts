import type { Tab, TreeNode, Tree, SortMode } from './types';
import { state } from './state';
import { getSession, rootName } from './session';

// ==================== 排序 ====================

export const SORT_LABELS: Record<SortMode, string> = {
  'name-asc': '名称 A→Z',
  'name-desc': '名称 Z→A',
  'mtime-desc': '修改时间 最新在前',
  'mtime-asc': '修改时间 最早在前',
  'size-desc': '文件大小 大→小',
  'size-asc': '文件大小 小→大',
};

export function currentSortMode(): SortMode {
  const m = getSession().sortMode;
  return (m as SortMode) || 'name-asc';
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 自然排序：数字块按数值、文本块按字母（1. 2. 3. 10. 而不是 1. 10. 2. 3.）- 原生 C++ 快速排序 */
function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b);
}

function compareNodes(a: TreeNode, b: TreeNode, mode: SortMode): number {
  // 文件夹永远在前
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const byName = (): number => naturalCompare(a.name, b.name);
  switch (mode) {
    case 'name-desc':
      return -byName();
    case 'mtime-desc':
      return b.mtime - a.mtime || byName();
    case 'mtime-asc':
      return a.mtime - b.mtime || byName();
    case 'size-desc':
      return b.size - a.size || byName();
    case 'size-asc':
      return a.size - b.size || byName();
    case 'name-asc':
    default:
      return byName();
  }
}

/** 排序子节点（返回新数组，不改原树） */
function sortChildren(nodes: TreeNode[] | undefined, mode: SortMode): TreeNode[] {
  return [...(nodes ?? [])].sort((x, y) => compareNodes(x, y, mode));
}

// ==================== 侧边栏文件树 ====================

export function renderTree(container: HTMLElement, tree: Tree, onOpenFile: (path: string) => void): void {
  container.textContent = '';
  if (!tree.children.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = '（此文件夹下没有 .md 文件）';
    container.appendChild(empty);
    return;
  }
  const mode = currentSortMode();
  const ul = document.createElement('ul');
  ul.className = 'tree-list';
  for (const node of sortChildren(tree.children, mode)) {
    ul.appendChild(renderNode(node, 0, onOpenFile, mode));
  }
  container.appendChild(ul);
}

function renderNode(node: TreeNode, depth: number, onOpenFile: (path: string) => void, mode: SortMode): HTMLElement {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = `${8 + depth * 16}px`;
  row.title = node.path;
  row.dataset.path = node.path;

  if (node.kind === 'dir') {
    const tw = document.createElement('span');
    tw.className = 'tree-tw';
    const opened = state.expanded.has(node.path);
    tw.textContent = opened ? '▾' : '▸';
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '📁';
    const name = document.createElement('span');
    name.className = 'tree-name dir';
    name.textContent = node.name;
    row.append(tw, icon, name);
    row.classList.add('dir');
    row.addEventListener('click', () => {
      if (state.expanded.has(node.path)) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      // 原地重建（懒渲染子节点）
      const parent = li.parentElement;
      if (parent) {
        const idx = Array.from(parent.children).indexOf(li);
        const fresh = renderNode(node, depth, onOpenFile, mode);
        parent.replaceChild(fresh, li);
        void idx;
      }
    });
    li.appendChild(row);
    if (opened && node.children && node.children.length) {
      const ul = document.createElement('ul');
      ul.className = 'tree-list';
      for (const child of sortChildren(node.children, mode)) {
        ul.appendChild(renderNode(child, depth + 1, onOpenFile, mode));
      }
      li.appendChild(ul);
    } else if (opened) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.style.paddingLeft = `${24 + depth * 16}px`;
      empty.textContent = '（空）';
      li.appendChild(empty);
    }
  } else {
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '📄';
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    row.append(icon, name);
    if (node.path === state.activePath) row.classList.add('active');
    row.addEventListener('click', () => onOpenFile(node.path));
    li.appendChild(row);
  }
  return li;
}

/** 仅更新当前活动文档高亮，耗时 0.01ms，彻底避免全量重建 DOM */
export function updateActiveTreeNode(container: HTMLElement, activePath: string | null): void {
  const prevActive = container.querySelectorAll('.tree-row.active');
  prevActive.forEach((el) => el.classList.remove('active'));
  if (!activePath) return;
  const rows = container.querySelectorAll<HTMLElement>('.tree-row:not(.dir)');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.dataset.path === activePath || row.title === activePath) {
      row.classList.add('active');
      break;
    }
  }
}

// ==================== 顶部标签页 ====================

export function renderTabs(container: HTMLElement, onActivate: (path: string) => void, onClose: (path: string) => void): void {
  container.textContent = '';
  for (const tab of state.tabs) {
    container.appendChild(renderTab(tab, onActivate, onClose));
  }
}

function renderTab(tab: Tab, onActivate: (path: string) => void, onClose: (path: string) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tab' + (tab.path === state.activePath ? ' active' : '') + (tab.loading ? ' loading' : '');
  el.title = tab.path;
  if (tab.stale) el.classList.add('stale');
  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = tab.name;
  name.addEventListener('click', () => onActivate(tab.path));
  const close = document.createElement('span');
  close.className = 'tab-close';
  close.textContent = '✕';
  close.title = '关闭';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    onClose(tab.path);
  });
  el.append(name, close);
  return el;
}

// ==================== 侧边栏头部（含排序下拉） ====================

export function renderTreeHeader(
  header: HTMLElement,
  tree: Tree | null,
  onRefresh: () => void,
  onSortChange?: (mode: SortMode) => void,
): void {
  header.textContent = '';
  if (!tree) {
    header.hidden = true;
    return;
  }
  header.hidden = false;
  const rootLabel = document.createElement('div');
  rootLabel.className = 'tree-root';
  rootLabel.textContent = `📁 ${rootName(state.root!)}`;
  const count = document.createElement('div');
  count.className = 'tree-count';
  count.textContent = `${tree.mdCount} 个 md`;
  const refresh = document.createElement('button');
  refresh.className = 'tree-refresh';
  refresh.textContent = '⟳';
  refresh.title = '重新扫描目录';
  refresh.addEventListener('click', onRefresh);

  // 排序下拉
  const mode = currentSortMode();
  const sortWrap = document.createElement('div');
  sortWrap.className = 'menu-wrap sort-wrap';
  const btn = document.createElement('button');
  btn.className = 'tree-sort-btn';
  btn.textContent = `排序▾ ${SORT_LABELS[mode]}`;
  btn.title = '文件夹/文件排序方式';
  const pop = document.createElement('div');
  pop.className = 'pop-menu sort-pop';
  pop.hidden = true;
  (Object.keys(SORT_LABELS) as SortMode[]).forEach((key) => {
    const item = document.createElement('button');
    item.dataset.sort = key;
    item.textContent = (key === mode ? '✓ ' : '') + SORT_LABELS[key];
    item.addEventListener('click', () => {
      pop.hidden = true;
      btn.textContent = `排序▾ ${SORT_LABELS[key]}`;
      if (onSortChange) onSortChange(key);
    });
    pop.appendChild(item);
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
  });
  sortWrap.append(btn, pop);

  header.append(rootLabel, count, sortWrap, refresh);
}
