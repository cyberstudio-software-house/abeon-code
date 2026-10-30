import { useStore } from '../../../store';
import type { ThemeMode } from '../../../styles/theme';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage } from '../controls';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Jasny' },
  { value: 'dark', label: 'Ciemny' },
  { value: 'system', label: 'Systemowy' },
];

export function AppearanceCategory() {
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const showActiveSessions = useStore(s => s.showActiveSessions);
  const setShowActiveSessions = useStore(s => s.setShowActiveSessions);

  return (
    <SettingsPage title={SETTINGS_CATEGORIES.appearance.label} description={SETTINGS_CATEGORIES.appearance.description}>
      <div className="space-y-6">
        <div>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
            Motyw
          </label>
          <div className="flex gap-1">
            {THEME_OPTIONS.map(o => (
              <button
                key={o.value}
                onClick={() => setTheme(o.value)}
                className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                  theme === o.value
                    ? 'bg-fg text-bg border-fg'
                    : 'bg-bg border-border text-muted hover:text-fg'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-2">
            Opcja „Systemowy" automatycznie dostosowuje motyw do ustawień systemu operacyjnego.
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Pasek boczny
          </label>
          <label className="flex items-center gap-2 text-[12px] cursor-pointer">
            <input
              type="checkbox"
              checked={showActiveSessions}
              onChange={e => setShowActiveSessions(e.target.checked)}
            />
            Pokaż aktywne sesje nad projektami
          </label>
        </div>
      </div>
    </SettingsPage>
  );
}
