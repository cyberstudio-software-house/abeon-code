import { useEffect, useState } from 'react';
import { tauri } from '../../../lib/tauri';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import type { DeploySettings, ToolStatus } from '../../../types';
import { MONO_FIELD_CLASS, SettingsPage, SettingsRow, SettingsSection } from '../controls';

const VPN_INPUT_ID = 'settings-deploy-vpn';

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return 'Nie udało się wykonać operacji';
}

function VpnSection() {
  const [settings, setSettings] = useState<DeploySettings | null>(null);
  const [text, setText] = useState('');
  const [stored, setStored] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    tauri.deployGetSettings()
      .then(loaded => {
        if (!active) return;
        setSettings(loaded);
        setText(loaded.vpnConnection ?? '');
        setStored(loaded.vpnConnection ?? '');
      })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);

  const commit = async () => {
    const trimmed = text.trim();
    if (trimmed === stored) {
      setText(trimmed);
      return;
    }
    setError(null);
    try {
      await tauri.deploySetVpnConnection(trimmed === '' ? null : trimmed);
      setText(trimmed);
      setStored(trimmed);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <SettingsSection label="Połączenie VPN">
      {settings && !settings.vpnSupported && (
        <p className="px-[18px] py-4 text-[12.5px] text-muted">Automatyczne łączenie z VPN działa tylko na Linuksie.</p>
      )}
      {settings?.vpnSupported && (
        <SettingsRow
          label="Nazwa połączenia w NetworkManagerze"
          htmlFor={VPN_INPUT_ID}
          description="Gdy klaster jest niedostępny, aplikacja spróbuje włączyć to połączenie i dokończy sprawdzanie wdrożenia."
        >
          <input
            id={VPN_INPUT_ID}
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={() => { void commit(); }}
            className={`${MONO_FIELD_CLASS} flex-[0_1_280px]`}
          />
        </SettingsRow>
      )}
      {!settings && !error && <p className="px-[18px] py-4 text-[12.5px] text-muted">Wczytywanie…</p>}
      {error && <p role="alert" className="px-[18px] py-3 text-[12px] text-danger">{error}</p>}
    </SettingsSection>
  );
}

function ToolsSection() {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    tauri.deployToolsStatus()
      .then(list => { if (active) setTools(list); })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);

  return (
    <SettingsSection label="Narzędzia">
      {tools?.map(tool => (
        <SettingsRow key={tool.tool} label={tool.tool} labelId={`settings-deploy-tool-${tool.tool}`}>
          <div className="flex min-w-0 flex-[0_1_340px] items-center gap-2.5 text-[12px]">
            <span className={`shrink-0 ${tool.found ? 'text-success' : 'text-danger'}`}>
              {tool.found ? 'Znaleziono' : 'Nie znaleziono'}
            </span>
            {tool.detail && <span className="min-w-0 truncate font-mono text-muted" title={tool.detail}>{tool.detail}</span>}
          </div>
        </SettingsRow>
      ))}
      {!tools && !error && <p className="px-[18px] py-4 text-[12.5px] text-muted">Sprawdzam…</p>}
      {error && <p role="alert" className="px-[18px] py-3 text-[12px] text-danger">{error}</p>}
    </SettingsSection>
  );
}

export function DeployCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.deploy.label} description={SETTINGS_CATEGORIES.deploy.description}>
      <VpnSection />
      <ToolsSection />
      <SettingsSection label="Powiadomienia na Discordzie">
        <p className="px-[18px] py-4 text-[12.5px] leading-[1.5] text-muted">
          Powiadomienia o wstrzymanym i nieudanym wdrożeniu trafiają na Discord tylko wtedy, gdy agent sterujący jest
          włączony i ma podłączony Discord. Bez tego zostają powiadomienia na pulpicie i oznaczenia w aplikacji.
        </p>
      </SettingsSection>
    </SettingsPage>
  );
}
