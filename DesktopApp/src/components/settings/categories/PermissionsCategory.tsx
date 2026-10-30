import { useStore } from '../../../store';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage, SettingsRow, SettingsSection, Switch } from '../controls';

export function PermissionsCategory() {
  const skipPermissions = useStore(s => s.skipPermissions);
  const setSkipPermissions = useStore(s => s.setSkipPermissions);

  return (
    <SettingsPage title={SETTINGS_CATEGORIES.permissions.label} description={SETTINGS_CATEGORIES.permissions.description}>
      <SettingsSection label="Uprawnienia">
        <SettingsRow
          label="Pomijaj pytania o uprawnienia"
          labelId="settings-permissions-skip"
          description={
            <>
              Dodaje flagę <code className="font-mono text-fg-secondary">--dangerously-skip-permissions</code> do każdej sesji Claude.
              Claude będzie mógł wykonywać operacje bez pytania o zgodę.
            </>
          }
        >
          <Switch checked={skipPermissions} onChange={setSkipPermissions} labelledBy="settings-permissions-skip" />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
