import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { OpenedRoot, RenderedMd, RootRef, SearchHit, Session, Tree } from './types';

export const api = {
  openFolder: () => invoke<OpenedRoot | null>('open_folder_picker'),
  openRoot: (root: RootRef) => invoke<OpenedRoot>('open_root', { root }),
  scanTree: (root: RootRef) => invoke<Tree>('scan_tree', { root }),
  renderMd: (path: string, dark: boolean) => invoke<RenderedMd>('render_md', { path, dark }),
  search: (root: string, query: string) =>
    root.startsWith('content://')
      ? invoke<SearchHit[]>('search_files_saf', { root, query })
      : invoke<SearchHit[]>('search_files', { root, query }),
  saveSession: (session: Session) => invoke<void>('save_session', { session }),
  loadSession: () => invoke<Session>('load_session'),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  resolveRel: (ctx: string, rel: string) => invoke<string>('resolve_rel', { ctx, rel }),
  onTreeChanged: (cb: (opened: OpenedRoot) => void) =>
    listen<OpenedRoot>('tree-changed', (e) => cb(e.payload)),
  onFileChanged: (cb: (paths: string[]) => void) =>
    listen<string[]>('file-changed', (e) => cb(e.payload)),
};

export function platform(): 'desktop' | 'android' {
  try {
    if (navigator.userAgent.includes('Android') || (window as any).__TAURI_INTERNALS__) {
      return navigator.userAgent.includes('Android') ? 'android' : 'desktop';
    }
  } catch {
    /* ignore */
  }
  return 'desktop';
}