import { useStore } from '../../../store';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage } from '../controls';

export function PermissionsCategory() {
  const skipPermissions = useStore(s => s.skipPermissions);
  const setSkipPermissions = useStore(s => s.setSkipPermissions);

  return (
    <SettingsPage title={SETTINGS_CATEGORIES.permissions.label} description={SETTINGS_CATEGORIES.permissions.description}>
      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
          Uprawnienia
        </label>
        <label className="flex items-start gap-3 cursor-pointer py-1.5 px-2 hover:bg-bg-elev-2">
          <input
            type="checkbox"
            checked={skipPermissions}
            onChange={e => setSkipPermissions(e.target.checked)}
            className="accent-accent mt-0.5"
          />
          <div>
            <span className="text-[13px]">Pomijaj pytania o uprawnienia</span>
            <p className="text-[11px] text-muted mt-0.5">
              Dodaje flagę <code className="font-mono text-fg-secondary">--dangerously-skip-permissions</code> do każdej sesji Claude.
              Claude będzie mógł wykonywać operacje bez pytania o zgodę.
            </p>
          </div>
        </label>
      </div>
    </SettingsPage>
  );
}
