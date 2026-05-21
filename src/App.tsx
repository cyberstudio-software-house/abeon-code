import { useEffect, useState } from 'react';
import { applyTheme, type ThemeMode } from './styles/theme';

export default function App() {
  const [mode, setMode] = useState<ThemeMode>('dark');
  useEffect(() => { applyTheme(mode); }, [mode]);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">AbeonCode</h1>
      <div className="flex gap-2">
        {(['light', 'dark', 'system'] as ThemeMode[]).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-3 py-1 rounded border border-border ${mode === m ? 'bg-accent text-accent-fg' : 'bg-bg-elev'}`}>
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}
