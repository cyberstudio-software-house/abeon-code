export type ThemeMode = 'light' | 'dark' | 'system';

export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : mode;
  root.setAttribute('data-theme', resolved);
}
