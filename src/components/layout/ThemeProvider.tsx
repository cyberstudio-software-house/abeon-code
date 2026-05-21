import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyTheme, type ThemeMode } from '../../styles/theme';

type Ctx = { mode: ThemeMode; setMode: (m: ThemeMode) => void };
const ThemeCtx = createContext<Ctx | null>(null);
const STORAGE_KEY = 'abeoncode.theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return (saved === 'light' || saved === 'dark' || saved === 'system') ? saved : 'dark';
  });

  useEffect(() => {
    applyTheme(mode);
    localStorage.setItem(STORAGE_KEY, mode);
    if (mode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode]);

  return <ThemeCtx.Provider value={{ mode, setMode: setModeState }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}
