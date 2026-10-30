import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { tauri } from '../../../lib/tauri';
import type { NotificationTrigger } from '../../../lib/attention';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { BUTTON_CLASS, SelectField, SettingsPage, SettingsRow, SettingsSection, Switch } from '../controls';

const TRIGGER_OPTIONS: { value: NotificationTrigger; label: string }[] = [
  { value: 'turnEnd', label: 'Każde zakończenie tury' },
  { value: 'questionsOnly', label: 'Tylko pytania / prośby o uprawnienie' },
  { value: 'both', label: 'Oba' },
];

function NotificationsSection() {
  const enabled = useStore(s => s.notificationsEnabled);
  const setEnabled = useStore(s => s.setNotificationsEnabled);
  const trigger = useStore(s => s.notificationTrigger);
  const setTrigger = useStore(s => s.setNotificationTrigger);
  const [hookInstalled, setHookInstalled] = useState<boolean | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);

  useEffect(() => {
    tauri.attentionHookStatus().then(setHookInstalled).catch(() => setHookInstalled(null));
  }, []);

  const doInstall = () => {
    tauri.installAttentionHook()
      .then(() => setHookInstalled(true))
      .catch(err => console.error('[notifications] install hook failed', err))
      .finally(() => setConfirmInstall(false));
  };

  const doUninstall = () => {
    tauri.uninstallAttentionHook()
      .then(() => setHookInstalled(false))
      .catch(err => console.error('[notifications] uninstall hook failed', err));
  };

  return (
    <>
      <SettingsSection label="Powiadomienia">
        <SettingsRow label="Powiadomienia systemowe, gdy sesja czeka na Ciebie" labelId="settings-notifications-enabled">
          <Switch checked={enabled} onChange={setEnabled} labelledBy="settings-notifications-enabled" />
        </SettingsRow>
        <SettingsRow label="Wyzwalaj na" htmlFor="settings-notifications-trigger">
          <SelectField
            id="settings-notifications-trigger"
            value={trigger}
            onChange={e => setTrigger(e.target.value as NotificationTrigger)}
            disabled={!enabled}
          >
            {TRIGGER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </SelectField>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Hook Claude Code">
        <SettingsRow
          label="Hook pytań Claude Code"
          labelId="settings-notifications-hook"
          description={
            <>
              Tryb „tylko pytania” wymaga hooka. Instalacja dopisuje wpis do{' '}
              <code className="font-mono text-fg-secondary">~/.claude/settings.json</code> (Twoje istniejące hooki zostają nienaruszone).
            </>
          }
        >
          <div className="flex items-center gap-2.5 text-[12.5px]">
            {hookInstalled === null && <span className="text-muted">—</span>}
            {hookInstalled === true && (
              <>
                <span className="text-success">zainstalowany</span>
                <button type="button" onClick={doUninstall} className={BUTTON_CLASS}>usuń</button>
              </>
            )}
            {hookInstalled === false && (
              <button type="button" onClick={() => setConfirmInstall(true)} className={BUTTON_CLASS}>
                Zainstaluj
              </button>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      {confirmInstall && (
        <ConfirmDialog
          title="Zainstalować hook Claude Code?"
          message="AbeonCode dopisze wpis hooka Notification do ~/.claude/settings.json. Istniejące hooki nie zostaną zmienione."
          onCancel={() => setConfirmInstall(false)}
          onConfirm={doInstall}
        />
      )}
    </>
  );
}

export function NotificationsCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.notifications.label} description={SETTINGS_CATEGORIES.notifications.description}>
      <NotificationsSection />
    </SettingsPage>
  );
}
