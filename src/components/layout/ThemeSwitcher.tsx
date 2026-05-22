import { useStore } from '../../store';
import type { ThemeMode } from '../../styles/theme';
const MODES: ThemeMode[] = ['dark', 'light', 'system'];
export function ThemeSwitcher() {
  const mode = useStore(s => s.theme);
  const setMode = useStore(s => s.setTheme);
  return (
    <div className="flex gap-1">
      {MODES.map(m => (
        <button key={m} onClick={() => setMode(m)}
          className={`px-2 py-1 text-[10px] rounded ${mode === m ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}>
          {m}
        </button>
      ))}
    </div>
  );
}
