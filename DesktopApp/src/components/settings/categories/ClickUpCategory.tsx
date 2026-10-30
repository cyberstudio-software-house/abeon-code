import { useCallback, useEffect, useState } from 'react';
import { tauri } from '../../../lib/tauri';
import type { ClickUpConnectionStatus } from '../../../types/ClickUpConnectionStatus';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage } from '../controls';

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

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">CLICKUP</span>
        <span className="text-[11px] text-fg-secondary">{label}</span>
      </div>
      <input
        type="password"
        value={token}
        onChange={e => setToken(e.target.value)}
        placeholder="pk_..."
        className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono placeholder:text-muted/60"
      />
      <div className="flex gap-2">
        <button disabled={busy || !token.trim()} onClick={save}
          className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50">Zapisz token</button>
        <button disabled={busy} onClick={test}
          className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Testuj połączenie</button>
        <button disabled={busy} onClick={clear}
          className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Usuń token</button>
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <p className="text-[11px] text-muted">Token wygenerujesz w ClickUp: Settings → Apps → API Token.</p>
    </section>
  );
}

export function ClickUpCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.clickup.label} description={SETTINGS_CATEGORIES.clickup.description}>
      <ClickUpTab />
    </SettingsPage>
  );
}
