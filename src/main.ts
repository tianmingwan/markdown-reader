import { api } from './api';
import './styles.css';
import { state } from './state';
import type { OpenedRoot, RootRef, SortMode, Tab, Tree, TreeNode } from './types';
import * as session from './session';
import * as theme from './theme';
import { renderTree, renderTabs, renderTreeHeader } from './tree';
import { renderPreview, restoreScroll, attachScrollListener } from './preview';
import { setupSearch } from './search';

// ---------------- DOM 缓存 ----------------
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const tabsBar = $<HTMLElement>('tabs');
const sidebar = $<HTMLElement>('sidebar');
const treeHeader = $<HTMLElement>('tree-header');
const treePanel = $<HTMLElement>('tree');
const resultsPanel = $<HTMLElement>('search-results');
const previewWrap = $<HTMLElement>('preview-wrap');
const emptyState = $<HTMLElement>('empty-state');
const loadingEl = $<HTMLElement>('loading');
const article = $<HTMLElement>('preview');
const statusbar = $<HTMLElement>('statusbar');
const toastEl = $<HTMLElement>('toast');
const searchInput = $<HTMLInputElement>('search-input');
const searchClear = $<HTMLElement>('search-clear');
const recentPop = $<HTMLElement>('recent-pop');
const themePop = $<HTMLElement>('theme-pop');
const recentHint = $<HTMLElement>('recent-hint');
const btnBack = $<HTMLElement>('btn-back');
const readerTitle = $<HTMLElement>('reader-title');

let safPollTimer: number | undefined;
let lastSafSignature = '';
let safScanning = false;

/** 预览内容元素（居中限宽层；article 只是整宽滚动容器） */
function contentEl(): HTMLElement {
  return document.querySelector('#preview-content') ?? article;
}

// ---------------- 手机模式（主从视图：列表页 ↔ 阅读页） ----------------
// 断点与平板/桌面一致：≤720px 视为手机竖屏。横屏手机/平板宽度 >720px 自动回到双栏布局。
const phoneMQ = window.matchMedia('(max-width: 720px)');
let isPhone = phoneMQ.matches;
let view: 'list' | 'reader' = 'list';

/** 按当前手机状态同步 body class 与顶栏按钮 */
function applyView(): void {
  document.body.classList.remove('phone', 'phone-list', 'phone-reader', 'phone-empty');
  if (!isPhone) return; // 平板/桌面：恢复双栏
  document.body.classList.add('phone');
  if (view === 'reader') {
    document.body.classList.add('phone-reader');
  } else {
    document.body.classList.add('phone-list');
    // 无根目录时列表区空无一物 → 让位给空状态引导页
    if (!state.root) document.body.classList.add('phone-empty');
  }
  btnBack.hidden = view !== 'reader';
}

/** 切回列表视图（顶栏返回按钮 / Android 系统返回键触发） */
function showList(): void {
  if (!isPhone || view === 'list') return;
  view = 'list';
  applyView();
  updateStatus();
}

/** 进入阅读视图（列表 → 阅读） */
function showReader(): void {
  if (!isPhone || view === 'reader') return;
  view = 'reader';
  applyView();
}

function setupPhoneMode(): void {
  // 顶栏返回按钮（桌面隐藏；手机阅读视图可见）
  btnBack.addEventListener('click', () => showList());
  // Android 系统返回键：由 MainActivity 拦截后回调这里。
  // 返回 'list' = 已处理（阅读→列表）；返回 'exit' = 应退出应用（列表页按返回）。
  // 不用 history API：每次 pushState 都会让 WebView 历史栈永久增长，
  // 导致列表页按返回要连按 N 次才能退出（N=会话内打开的文档数）。
  (window as any).__mdBack = (): string => {
    // 先关闭可能打开的下拉菜单
    const openPop = [...document.querySelectorAll<HTMLElement>('.pop-menu')].find((p) => !p.hidden);
    if (openPop) {
      openPop.hidden = true;
      return 'list';
    }
    if (isPhone && view === 'reader') {
      showList();
      return 'list';
    }
    return 'exit';
  };
  // 横竖屏切换 / 窗口尺寸变化时重新判定
  phoneMQ.addEventListener('change', (e) => {
    isPhone = e.matches;
    if (!isPhone) {
      view = 'list';
      applyView();
      return;
    }
    view = state.activePath ? 'reader' : 'list';
    applyView();
  });
  applyView();
}

// ---------------- 字号调节 ----------------
const FONT_MIN = 13;
const FONT_MAX = 21;

function applyFontSize(): void {
  const size = session.getSession().fontSize ?? 15;
  document.documentElement.style.setProperty('--md-font-size', `${size}px`);
}

function adjustFontSize(delta: number): void {
  const cur = session.getSession().fontSize ?? 15;
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, cur + delta));
  if (next === cur) return;
  session.setFontSize(next);
  applyFontSize();
  void session.flush(); // 立即保存字号设置
  // 内容高度随字号变化，按比例恢复当前阅读位置
  const tab = state.tabs.find((t) => t.path === state.activePath);
  if (tab) restoreScroll(article, tab.ratio);
}

function setupFontControls(): void {
  $<HTMLElement>('btn-font-inc').addEventListener('click', () => adjustFontSize(1));
  $<HTMLElement>('btn-font-dec').addEventListener('click', () => adjustFontSize(-1));
}

// ---------------- 通知 ----------------
let toastTimer: number | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2600);
}

// ---------------- 状态栏 ----------------
function updateStatus(): void {
  const tab = state.tabs.find((t) => t.path === state.activePath) ?? null;
  // 手机阅读视图顶栏标题
  readerTitle.textContent = tab ? tab.name : '';
  const root = state.root;
  if (!root || !state.tree) {
    statusbar.textContent = '';
    return;
  }
  const pct = tab ? Math.round(tab.ratio * 100) : 0;
  const size = tab ? formatSize(tab.size) : '';
  statusbar.textContent = `${session.rootName(root)} · ${state.tree.mdCount} 个 md  |  正在阅读：${
    tab ? tab.name : '—'
  }  ${tab ? `| ${size} · ${tab.words} 字 · 已读到 ${pct}%` : ''}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------- 打开/切换/关闭标签 ----------------
async function openTab(path: string, fragment?: string): Promise<void> {
  if (!state.root) return;
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) {
    activateTab(path);
    if (fragment) scrollToFragment(path, fragment);
    return;
  }
  const tab: Tab = {
    path,
    // 标签名：优先用目录树中的权威名字（后端已解码）；
    // SAF content URI 的 docId 是百分号编码的，直接 split('/') 会得到一长串乱码
    name: findNodeInfo(path)?.name ?? displayNameOf(path),
    html: '',
    hasMath: false,
    hasMermaid: false,
    words: 0,
    size: 0,
    mtime: 0,
    ratio: session.takePosition(state.root, path) ?? 0,
    loading: true,
    stale: false,
  };
  state.tabs.push(tab);
  state.activePath = path;
  repaintTabs();
  showReader(); // 手机模式：列表 → 阅读
  showLoading();
  expandAncestorsFor(path);

  try {
    const r = await api.renderMd(path, theme.effective() === 'dark');
    const t = state.tabs.find((x) => x.path === path);
    if (!t) return;
    t.html = r.html;
    t.hasMath = r.hasMath;
    t.hasMermaid = r.hasMermaid;
    t.words = r.words;
    t.loading = false;
    const info = findNodeInfo(path);
    if (info) {
      t.size = info.size;
      t.mtime = info.mtime;
    } else {
      // 文件信息未在树中找到（如 SAF），尝试直接读取大小不可得则忽略
      t.size = 0;
    }
    if (state.activePath === path) {
      await paintPreview(t);
      if (fragment) scrollToFragment(path, fragment);
    }
  } catch (e) {
    const t = state.tabs.find((x) => x.path === path);
    if (t) {
      t.loading = false;
      t.error = String(e);
    }
    if (state.activePath === path) {
      article.hidden = false;
      contentEl().innerHTML = `<div class="preview-error">无法打开文件：<code>${path}</code><br/>${escapeHtml(String(e))}</div>`;
      loadingEl.hidden = true;
    }
  }
  hideLoadingIfIdle();
  repaintTree();
  repaintTabs();
  updateStatus();
  await session.rememberFile(path);
}

/** 兜底取显示名：解码百分号编码并取最后一段（SAF docId 形如 primary%3A...%2F目录%2F文件.md） */
function displayNameOf(path: string): string {
  let last = path.split('/').pop() ?? path;
  try {
    last = decodeURIComponent(last);
  } catch {
    /* 保留原样 */
  }
  const seg = last.split('/').pop();
  return seg && seg.length > 0 ? seg : last;
}

function expandAncestorsFor(path: string): void {
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (n.kind !== 'dir') continue;
      // SAF 路径分隔符是 %2F（编码的 /），两种都要匹配
      if (path.startsWith(n.path + '/') || path.startsWith(n.path + '%2F')) {
        state.expanded.add(n.path);
        walk(n.children ?? []);
        return;
      }
    }
  };
  walk(state.tree?.children ?? []);
}

function findNodeInfo(path: string): { name: string; size: number; mtime: number } | null {
  const walk = (nodes: TreeNode[]): { name: string; size: number; mtime: number } | null => {
    for (const n of nodes) {
      if (n.path === path) return { name: n.name, size: n.size, mtime: n.mtime };
      if (n.children) {
        const r = walk(n.children);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(state.tree?.children ?? []);
}

async function paintPreview(tab: Tab): Promise<void> {
  article.hidden = false;
  emptyState.hidden = true;
  loadingEl.hidden = true;
  if (tab.error) {
    contentEl().innerHTML = `<div class="preview-error">${escapeHtml(tab.error)}</div>`;
    restoreScroll(article, tab.ratio);
    return;
  }
  await renderPreview(article, tab, theme.effective() === 'dark', {
    onOpenFile: (p, frag) => void openTab(p, frag),
  });
  restoreScroll(article, tab.ratio);
}

function activateTab(path: string): void {
  if (state.activePath === path) {
    // 手机模式：列表页点击「当前活动文档」→ 重新进入阅读视图
    showReader();
    return;
  }
  state.activePath = path;
  repaintTabs();
  showReader(); // 手机模式：列表点击已打开文档也要进阅读视图（无操作则幂等）
  const tab = state.tabs.find((t) => t.path === path);
  if (tab) {
    if (tab.error) {
      void paintPreview(tab);
    } else {
      void (async () => {
        await paintPreview(tab);
      })();
    }
    void session.rememberFile(path);
  }
  repaintTree();
  updateStatus();
}

function scrollToFragment(path: string, fragment: string): void {
  const tab = state.tabs.find((t) => t.path === path);
  if (!tab) return;
  const el = fragment
    ? article.querySelector(`[id="${CSS.escape(fragment)}"]`)
    : null;
  if (el) {
    el.scrollIntoView({ block: 'start' });
  } else if (tab.path === state.activePath) {
    restoreScroll(article, tab.ratio);
  }
}

function closeTab(path: string): void {
  const idx = state.tabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  if (state.activePath === path) {
    const next = state.tabs[idx] ?? state.tabs[idx - 1];
    state.activePath = next ? next.path : null;
  }
  repaintTabs();
  if (state.activePath) {
    const tab = state.tabs.find((t) => t.path === state.activePath)!;
    void paintPreview(tab);
  } else {
    article.hidden = true;
    loadingEl.hidden = true;
    if (state.root && state.tree) {
      emptyState.hidden = false;
    }
    // 手机模式：最后一个标签关闭后回到列表视图
    if (isPhone && view === 'reader') showList();
  }
  repaintTree();
  updateStatus();
  void session.flush();
}

// ---------------- 渲染辅助 ----------------
function showLoading(): void {
  loadingEl.hidden = false;
  article.hidden = true;
}

function hideLoadingIfIdle(): void {
  const anyLoading = state.tabs.some((t) => t.loading && t.path === state.activePath);
  if (!anyLoading) loadingEl.hidden = true;
}

function repaintTabs(): void {
  renderTabs(tabsBar, activateTab, closeTab);
}

function repaintTree(): void {
  if (!state.tree) return;
  renderTree(treePanel, state.tree, (p) => void openTab(p));
}

// ---------------- 设置根目录 ----------------
function setRoot(opened: OpenedRoot, opts: { restoreFile?: boolean } = {}): void {
  const switchingRoot = state.root !== null;
  session.rememberRoot(opened.root);
  state.root = opened.root;
  state.tree = opened.tree;
  state.tabs = [];
  state.activePath = null;
  state.expanded = new Set<string>();
  renderTreeHeader(treeHeader, state.tree, () => void refreshTree(), handleSortChange);
  repaintTree();
  repaintTabs();
  emptyState.hidden = true;

  if (opts.restoreFile && session.getSession().lastFile) {
    const last = session.getSession().lastFile!;
    if (last && !switchingRoot && session.getSession().lastRoot) {
      const lr = session.getSession().lastRoot!;
      if (lr.kind === opened.root.kind && lr.loc === opened.root.loc) {
        void openTab(last);
        return;
      }
    }
  }
  const first = firstMdPath();
  if (first) void openTab(first);
  startSafPoll();
  updateStatus();
  void session.flush();
  // 手机模式：无文档时确保停在列表视图（applyView 同步 body class）
  if (isPhone && !state.activePath) {
    view = 'list';
    applyView();
  }
}

function firstMdPath(): string | null {
  const walk = (nodes: TreeNode[]): string | null => {
    for (const n of nodes) {
      if (n.kind === 'file') return n.path;
      if (n.children) {
        const f = walk(n.children);
        if (f) return f;
      }
    }
    return null;
  };
  return walk(state.tree?.children ?? []);
}

async function refreshTree(): Promise<void> {
  if (!state.root) return;
  try {
    const tree = await api.scanTree(state.root);
    state.tree = tree;
    renderTreeHeader(treeHeader, tree, () => void refreshTree(), handleSortChange);
    repaintTree();
    updateStatus();
  } catch (e) {
    toast(`刷新失败：${String(e)}`);
  }
}

// ---------------- 文件/目录变化事件 ----------------
function applyTreeChanged(opened: OpenedRoot): void {
  const cur = state.root;
  if (cur && (cur.kind !== opened.root.kind || cur.loc !== opened.root.loc)) return;
  const wasNone = !cur;
  state.root = opened.root;
  state.tree = opened.tree;
  renderTreeHeader(treeHeader, state.tree, () => void refreshTree(), handleSortChange);
  repaintTree();

  if (wasNone) {
    // 例如 MDREADER_DEV_FOLDER 启动场景：后端已打开目录
    session.rememberRoot(opened.root);
    emptyState.hidden = true;
    const first = firstMdPath();
    if (first) void openTab(first);
    startSafPoll();
  } else {
    // 检查已打开标签是否还存在
    for (const tab of [...state.tabs]) {
      if (!pathExistsInTree(tab.path)) closeTab(tab.path);
    }
  }
  // 手机模式：活动文档消失后回到列表视图
  if (isPhone && !state.activePath && view === 'reader') showList();
  updateStatus();
}

function pathExistsInTree(path: string): boolean {
  const walk = (nodes: TreeNode[]): boolean =>
    nodes.some((n) => n.path === path || (n.children ? walk(n.children) : false));
  return walk(state.tree?.children ?? []);
}

async function applyFileChanged(paths: string[]): Promise<void> {
  if (!state.root) return;
  const dark = theme.effective() === 'dark';
  const changed = new Set(paths);
  for (const tab of state.tabs) {
    if (!changed.has(tab.path)) continue;
    try {
      const r = await api.renderMd(tab.path, dark);
      const fresh = state.tabs.find((t) => t.path === tab.path);
      if (!fresh) continue;
      fresh.html = r.html;
      fresh.hasMath = r.hasMath;
      fresh.hasMermaid = r.hasMermaid;
      fresh.words = r.words;
      if (fresh.path === state.activePath) {
        const ratio = fresh.ratio;
        await paintPreview(fresh);
        restoreScroll(article, ratio);
      } else {
        fresh.stale = true;
      }
    } catch {
      const t = state.tabs.find((x) => x.path === tab.path);
      if (t) {
        t.error = '文件已被删除或无法读取';
        if (t.path === state.activePath) void paintPreview(t);
      }
    }
  }
  repaintTabs();
  updateStatus();
}

// ---------------- 安卓 SAF 轮询 ----------------
function startSafPoll(): void {
  if (!state.root || state.root.kind !== 'saf') return;
  if (safPollTimer) window.clearInterval(safPollTimer);
  lastSafSignature = '';
  safScanning = false;
  safPollTimer = window.setInterval(() => {
    if (document.hidden || !state.root || state.root.kind !== 'saf') return;
    // 大目录扫描可能超过 4 秒：上一轮未结束时跳过本轮，防止扫描堆积卡 UI
    if (safScanning) return;
    safScanning = true;
    void (async () => {
      try {
        const tree = await api.scanTree(state.root!);
        const sig = treeSignature(tree);
        if (sig !== lastSafSignature) {
          lastSafSignature = sig;
          applyTreeChanged({ root: state.root!, tree });
          // 轮询后活动文件重新比对（SAF 无事件推送）
          const active = state.activePath;
          if (active) {
            const info = findNodeInfo(active);
            const tab = state.tabs.find((t) => t.path === active);
            if (info && tab && info.mtime !== tab.mtime) {
              void applyFileChanged([active]);
            }
          }
        }
      } catch {
        /* 权限丢失等错误静默 */
      } finally {
        safScanning = false;
      }
    })();
  }, 4000);
}

// ---------------- 最近打开菜单 ----------------
function renderRecentMenu(): void {
  recentPop.textContent = '';
  const roots = session.getSession().recentRoots;
  if (!roots.length) {
    const d = document.createElement('div');
    d.className = 'recent-item muted';
    d.textContent = '（暂无记录）';
    recentPop.appendChild(d);
  }
  for (const r of roots) {
    const d = document.createElement('div');
    d.className = 'recent-item';
    d.textContent = `${r.kind === 'saf' ? '📱' : '📁'} ${session.rootName(r)}`;
    d.title = r.loc;
    d.addEventListener('click', () => {
      recentPop.hidden = true;
      void (async () => {
        try {
          const opened = await api.openRoot(r);
          setRoot(opened);
        } catch (e) {
          toast(`无法打开：${String(e)}`);
        }
      })();
    });
    recentPop.appendChild(d);
  }
}

function renderRecentHint(): void {
  const roots = session.getSession().recentRoots.slice(0, 4);
  recentHint.textContent = '';
  if (!roots.length) return;
  recentHint.hidden = false;
  const label = document.createElement('div');
  label.className = 'recent-hint-label';
  label.textContent = '最近打开：';
  recentHint.appendChild(label);
  for (const r of roots) {
    const b = document.createElement('button');
    b.textContent = session.rootName(r);
    b.addEventListener('click', () => {
      void (async () => {
        try {
          const opened = await api.openRoot(r);
          setRoot(opened);
        } catch (e) {
          toast(`无法打开：${String(e)}`);
        }
      })();
    });
    recentHint.appendChild(b);
  }
}

// ---------------- 主题 ----------------
function setupThemeMenu(): void {
  themePop.querySelectorAll('button[data-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = (btn as HTMLElement).dataset.theme as 'system' | 'light' | 'dark';
      theme.setMode(m);
      themePop.hidden = true;
      void reRenderAllTabs();
    });
  });
  $<HTMLElement>('btn-theme').addEventListener('click', (e) => {
    e.stopPropagation();
    themePop.hidden = !themePop.hidden;
  });
  document.addEventListener('click', () => {
    // 关闭所有下拉菜单（含动态创建的排序下拉）
    document.querySelectorAll('.pop-menu').forEach((el) => {
      (el as HTMLElement).hidden = true;
    });
  });
}

/** 排序方式变化：保存 + 重绘树 + 重建头部 */
function handleSortChange(mode: SortMode): void {
  session.setSortMode(mode);
  void session.flush(); // 立即保存排序设置
  repaintTree();
  if (state.tree) {
    renderTreeHeader(treeHeader, state.tree, () => void refreshTree(), handleSortChange);
  }
}

async function reRenderAllTabs(): Promise<void> {
  if (!state.root) return;
  const dark = theme.effective() === 'dark';
  for (const tab of state.tabs) {
    try {
      const r = await api.renderMd(tab.path, dark);
      const fresh = state.tabs.find((t) => t.path === tab.path);
      if (!fresh) continue;
      fresh.html = r.html;
      fresh.hasMath = r.hasMath;
      fresh.hasMermaid = r.hasMermaid;
      fresh.words = r.words;
    } catch {
      /* 忽略单个失败 */
    }
  }
  const active = state.tabs.find((t) => t.path === state.activePath);
  if (active) await paintPreview(active);
  updateStatus();
}

// ---------------- 工具 ----------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const m: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return m[c];
  });
}

/** 目录树签名：SAF 轮询对比用 */
function treeSignature(tree: Tree): string {
  const walk = (nodes: TreeNode[]): string =>
    nodes
      .map(
        (n) =>
          `${n.path}|${n.kind}|${n.mtime}|${n.size}` +
          (n.children ? '/' + walk(n.children) : ''),
      )
      .join(';');
  return `${tree.path}|${tree.mdCount}|` + walk(tree.children);
}

async function boot(): Promise<void> {
  await session.loadSession();
  theme.apply();
  applyFontSize();
  theme.watchSystem();
  setupThemeMenu();
  setupFontControls();
  setupPhoneMode();
  setupSearch(searchInput, searchClear, resultsPanel, treePanel, (p) => void openTab(p));
  renderRecentHint();

  $<HTMLElement>('btn-open').addEventListener('click', () => {
    void (async () => {
      try {
        const opened = await api.openFolder();
        if (opened) setRoot(opened);
      } catch (e) {
        toast(`打开失败：${String(e)}`);
      }
    })();
  });

  $<HTMLElement>('btn-recent').addEventListener('click', (e) => {
    e.stopPropagation();
    renderRecentMenu();
    recentPop.hidden = !recentPop.hidden;
  });

  $<HTMLElement>('btn-sidebar').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-hidden');
  });

  api.onTreeChanged((opened) => applyTreeChanged(opened));
  api.onFileChanged((paths) => void applyFileChanged(paths));

  attachScrollListener(
    article,
    () => state.root,
    () => {
      const tab = state.tabs.find((t) => t.path === state.activePath);
      return tab ? tab.path : null;
    },
    (ratio) => {
      const tab = state.tabs.find((t) => t.path === state.activePath);
      if (tab) {
        tab.ratio = ratio;
        updateStatus();
      }
    },
  );

  window.addEventListener('beforeunload', () => void session.flush());

  // 恢复上次会话
  const s = session.getSession();
  if (s.lastRoot) {
    try {
      const opened = await api.openRoot(s.lastRoot);
      setRoot(opened, { restoreFile: true });
      return;
    } catch {
      /* 目录不可用则进入空状态 */
    }
  }
  emptyState.hidden = false;
  updateStatus();
}

// ==================== 启动 ====================
void boot();