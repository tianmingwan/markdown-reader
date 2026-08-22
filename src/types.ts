// 与 Rust 后端共享的数据结构（serde camelCase 对齐）

export interface RootRef {
  kind: 'fs' | 'saf';
  loc: string;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size: number;
  mtime: number;
  children?: TreeNode[];
}

export interface Tree {
  name: string;
  path: string;
  mdCount: number;
  children: TreeNode[];
}

export interface OpenedRoot {
  root: RootRef;
  tree: Tree;
}

export interface RenderedMd {
  html: string;
  hasMath: boolean;
  hasMermaid: boolean;
  words: number;
}

export interface SearchHit {
  path: string;
  name: string;
  matchedBy: 'name' | 'content';
  snippets: string[];
}

export interface Session {
  recentRoots: RootRef[];
  lastRoot: RootRef | null;
  lastFile: string | null;
  filePositions: Record<string, number>;
  theme: string | null;
  /** 正文字号 px；null = 默认 15 */
  fontSize: number | null;
  /** 文件树排序；null = name-asc */
  sortMode: string | null;
}

/** 文件树排序方式 */
export type SortMode =
  | 'name-asc'
  | 'name-desc'
  | 'mtime-desc'
  | 'mtime-asc'
  | 'size-desc'
  | 'size-asc';

export interface Tab {
  path: string;
  name: string;
  html: string;
  hasMath: boolean;
  hasMermaid: boolean;
  words: number;
  size: number;
  mtime: number;
  ratio: number;
  loading: boolean;
  error?: string;
  stale: boolean;
}

export function isMdPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}