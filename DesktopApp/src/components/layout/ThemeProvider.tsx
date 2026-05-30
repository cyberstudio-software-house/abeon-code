import { useEffect, type ReactNode } from 'react';
import { applyTheme } from '../../styles/theme';
import { useStore } from '../../store';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useStore(s => s.theme);
  useEffect(() => {
    applyTheme(mode);
    if (mode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mql.addEventListener('change', h);
    return () => mql.removeEventListener('change', h);
  }, [mode]);
  return <>{children}</>;
}

export function useTheme() {
  return { mode: useStore(s => s.theme), setMode: useStore(s => s.setTheme) };
}
