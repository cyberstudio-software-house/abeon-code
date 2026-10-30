import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SupervisorSettingsTab } from '../../dialogs/SupervisorSettingsTab';
import { SettingsPage } from '../controls';

export function SupervisorCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.supervisor.label} description={SETTINGS_CATEGORIES.supervisor.description}>
      <SupervisorSettingsTab />
    </SettingsPage>
  );
}
