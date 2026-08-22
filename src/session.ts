import { api } from './api';
import type { RootRef, Session } from './types';

let current: Session = {
  recentRoots: [],
  lastRoot: null,
  lastFile: null,
  filePositions: {},
  theme: null,
  fontSize: null,
  sortMode: null,
};
let dirty = false;
let timer: number | undefined;

export function getSession(): Session {
  return current;
}

export async function loadSession(): Promise<void> {
  try {
    current = await api.loadSession();
  } catch {
    /* 首次运行无会话文件 */
  }
}

export function markDirty(): void {
  dirty = true;
  if (!timer) timer = window.setTimeout(() => void flush(), 800);
}

export async function flush(): Promise<void> {
  if (timer) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  if (!dirty) return;
  dirty = false;
  try {
    await api.saveSession(current);
  } catch {
    /* 写失败不致命 */
  }
}

export function posKey(root: RootRef, path: string): string {
  return `${root.kind}:${root.loc}|${path}`;
}

/** 记录某文档的滚动比例（内部节流保存） */
export function recordPosition(root: RootRef, path: string, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio < 0) ratio = 0;
  const key = posKey(root, path);
  if (Math.abs((current.filePositions[key] ?? 0) - ratio) > 0.001) {
    current.filePositions[key] = ratio;
    markDirty();
  }
}

export function takePosition(root: RootRef, path: string): number | undefined {
  return current.filePositions[posKey(root, path)];
}

export function rememberRoot(root: RootRef): void {
  current.recentRoots = current.recentRoots.filter(
    (r) => !(r.kind === root.kind && r.loc === root.loc),
  );
  current.recentRoots.unshift(root);
  current.recentRoots = current.recentRoots.slice(0, 8);
  current.lastRoot = root;
  markDirty();
}

export function rememberFile(file: string): void {
  if (current.lastFile !== file) {
    current.lastFile = file;
    markDirty();
  }
}

export function setThemePref(t: string | null): void {
  if (current.theme !== t) {
    current.theme = t;
    markDirty();
  }
}

export function setFontSize(px: number): void {
  if (current.fontSize !== px) {
    current.fontSize = px;
    markDirty();
  }
}

export function setSortMode(mode: string): void {
  if (current.sortMode !== mode) {
    current.sortMode = mode;
    markDirty();
  }
}

export function rootName(root: RootRef): string {
  const s = root.loc.replace(/\/+$/, '');
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(idx + 1) : s;
}