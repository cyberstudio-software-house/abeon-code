import { useStore } from '../../../store';
import type { ThemeMode } from '../../../styles/theme';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { Segmented, SettingsPage, SettingsRow, SettingsSection, Switch } from '../controls';

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
      <SettingsSection label="Motyw">
        <SettingsRow
          label="Motyw"
          labelId="settings-appearance-theme"
          description="Opcja „Systemowy” automatycznie dostosowuje motyw do ustawień systemu operacyjnego."
        >
          <Segmented
            value={theme}
            options={THEME_OPTIONS}
            onChange={setTheme}
            labelledBy="settings-appearance-theme"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Pasek boczny">
        <SettingsRow label="Pokaż aktywne sesje nad projektami" labelId="settings-appearance-active-sessions">
          <Switch
            checked={showActiveSessions}
            onChange={setShowActiveSessions}
            labelledBy="settings-appearance-active-sessions"
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
