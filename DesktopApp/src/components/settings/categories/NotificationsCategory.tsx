import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { tauri } from '../../../lib/tauri';
import type { NotificationTrigger } from '../../../lib/attention';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { SettingsPage } from '../controls';
import { SELECT_BASE } from './shared';

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
    <div className="space-y-3">
      <h3 className="text-[12px] font-semibold text-fg">Powiadomienia</h3>

      <label className="flex items-center gap-2 text-[12px] cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        Powiadomienia systemowe, gdy sesja czeka na Ciebie
      </label>

      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-muted">Wyzwalaj na:</span>
        <select
          value={trigger}
          onChange={e => setTrigger(e.target.value as NotificationTrigger)}
          disabled={!enabled}
          className={`${SELECT_BASE} px-2 py-1 text-[12px]`}
        >
          {TRIGGER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-muted">Hook pytań Claude Code:</span>
        {hookInstalled === null && <span className="text-muted">—</span>}
        {hookInstalled === true && (
          <>
            <span className="text-success">zainstalowany</span>
            <button onClick={doUninstall} className="text-muted hover:text-danger underline">usuń</button>
          </>
        )}
        {hookInstalled === false && (
          <button onClick={() => setConfirmInstall(true)} className="text-accent underline">
            Zainstaluj
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted">
        Tryb „tylko pytania" wymaga hooka. Instalacja dopisuje wpis do
        <code className="mx-1">~/.claude/settings.json</code> (Twoje istniejące hooki zostają nienaruszone).
      </p>

      {confirmInstall && (
        <ConfirmDialog
          title="Zainstalować hook Claude Code?"
          message="AbeonCode dopisze wpis hooka Notification do ~/.claude/settings.json. Istniejące hooki nie zostaną zmienione."
          onCancel={() => setConfirmInstall(false)}
          onConfirm={doInstall}
        />
      )}
    </div>
  );
}

export function NotificationsCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.notifications.label} description={SETTINGS_CATEGORIES.notifications.description}>
      <NotificationsSection />
    </SettingsPage>
  );
}
