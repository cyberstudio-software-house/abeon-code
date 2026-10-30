import { useCallback, useEffect, useState } from 'react';
import { tauri } from '../../../lib/tauri';
import type { ClickUpConnectionStatus } from '../../../types/ClickUpConnectionStatus';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import {
  BUTTON_CLASS, MONO_FIELD_CLASS, PRIMARY_BUTTON_CLASS, SettingsPage, SettingsRow, SettingsSection,
} from '../controls';

function ClickUpTab() {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<ClickUpConnectionStatus>('absent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { setStatus(await tauri.clickupConnectionStatus()); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    try { await tauri.clickupSetToken(token); setToken(''); }
    catch (e) { setError(String(e)); return; }
    await refresh();
  };
  const test = async () => {
    const t = token.trim();
    if (t) {
      try { await tauri.clickupSetToken(t); setToken(''); }
      catch (e) { setError(String(e)); return; }
    }
    await refresh();
  };
  const clear = async () => {
    try { await tauri.clickupClearToken(); }
    catch (e) { setError(String(e)); return; }
    await refresh();
  };

  const label =
    busy ? 'Sprawdzam…' :
    status === 'configured' ? 'Połączono' :
    status === 'invalid' ? 'Token nieprawidłowy' : 'Brak tokenu';

  const statusTone =
    busy ? 'text-muted' :
    status === 'configured' ? 'text-success' :
    status === 'invalid' ? 'text-danger' : 'text-muted';

  return (
    <SettingsSection label="Połączenie" action={<span className={`text-[12px] ${statusTone}`}>{label}</span>}>
      <SettingsRow
        label="Token API"
        htmlFor="settings-clickup-token"
        description="Token wygenerujesz w ClickUp: Settings → Apps → API Token."
      >
        <input
          id="settings-clickup-token"
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="pk_..."
          className={`${MONO_FIELD_CLASS} flex-[0_1_280px]`}
        />
      </SettingsRow>
      <div className="flex flex-wrap items-center gap-2 px-[18px] py-3.5">
        <button type="button" disabled={busy || !token.trim()} onClick={save} className={PRIMARY_BUTTON_CLASS}>
          Zapisz token
        </button>
        <button type="button" disabled={busy} onClick={test} className={BUTTON_CLASS}>Testuj połączenie</button>
        <button type="button" disabled={busy} onClick={clear} className={BUTTON_CLASS}>Usuń token</button>
        {error && <p className="basis-full text-[12px] text-danger">{error}</p>}
      </div>
    </SettingsSection>
  );
}

export function ClickUpCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.clickup.label} description={SETTINGS_CATEGORIES.clickup.description}>
      <ClickUpTab />
    </SettingsPage>
  );
}
