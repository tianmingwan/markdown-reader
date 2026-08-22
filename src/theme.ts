import { flush, getSession, setThemePref } from './session';

export type ThemeMode = 'system' | 'light' | 'dark';

export function effective(): 'light' | 'dark' {
  const t = getSession().theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function mode(): ThemeMode {
  const t = getSession().theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function apply(): void {
  const e = effective();
  document.documentElement.dataset.theme = e;
  document.getElementById('btn-theme')!.textContent = e === 'dark' ? '🌙' : '☀️';
}

export function setMode(m: ThemeMode): void {
  setThemePref(m === 'system' ? null : m);
  apply();
  // 立即持久化：避免用户在防抖窗口内关闭应用导致主题丢失
  void flush();
}

export function watchSystem(): void {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (getSession().theme === null) apply();
    });
}