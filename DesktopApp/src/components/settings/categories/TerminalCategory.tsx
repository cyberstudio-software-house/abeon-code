import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage } from '../controls';

export function TerminalCategory() {
  return <SettingsPage title={SETTINGS_CATEGORIES.terminal.label} description={SETTINGS_CATEGORIES.terminal.description} />;
}
