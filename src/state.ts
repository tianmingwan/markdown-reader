// 全局状态单例：树 / 标签页 / 展开状态

import type { RootRef, Tab, Tree, TreeNode } from './types';

export const state = {
  root: null as RootRef | null,
  tree: null as Tree | null,
  tabs: [] as Tab[],
  activePath: null as string | null,
  expanded: new Set<string>(),
  searchBusy: false,
  searchSeq: 0,
};

export type { TreeNode };