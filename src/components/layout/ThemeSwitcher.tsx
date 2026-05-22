import { useStore } from '../../store';
import type { ThemeMode } from '../../styles/theme';
const MODES: ThemeMode[] = ['dark', 'light', 'system'];
export function ThemeSwitcher() {
  const mode = useStore(s => s.theme);
  const setMode = useStore(s => s.setTheme);
  return (
    <div className="flex gap-0.5">
      {MODES.map(m => (
        <button key={m} onClick={() => setMode(m)}
          className={`px-2 py-0.5 text-[10px] ${mode === m ? 'bg-fg text-bg' : 'text-muted hover:text-fg'}`}>
          {m}
        </button>
      ))}
    </div>
  );
}
