import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../store';
import { Icon } from '../../shared/Icon';
import { buildClaudeModelRows, DEFAULT_TITLE_GEN_MODEL_ID } from '../../../lib/models';
import { tauri } from '../../../lib/tauri';
import type { Provider, ProviderInfo } from '../../../types';
import { ALL_PROVIDERS, PROVIDER_LABEL, PROVIDER_ICON } from '../../../lib/providers';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import {
  BUTTON_CLASS, SelectField, SettingsPage, SettingsRow, SettingsSection, Switch,
} from '../controls';
import { AUTO_MODEL_LABEL, useClaudeOptions } from './shared';

function ProviderLabel({ provider }: { provider: Provider }) {
  return (
    <span className="flex items-center gap-2">
      <Icon name={PROVIDER_ICON[provider]} className="h-3.5 w-3.5 text-icon" />
      {PROVIDER_LABEL[provider]}
    </span>
  );
}

function ProvidersSection() {
  const enabled = useStore(useShallow(s => s.enabledProviders));
  const toggle = useStore(s => s.toggleProvider);
  const [infos, setInfos] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    tauri.detectProviders().then(setInfos).catch(() => setInfos([]));
  }, []);

  return (
    <SettingsSection
      label="Dostawcy CLI"
      description="Gdy włączony jest więcej niż jeden dostawca, „New session” najpierw pyta, w którym CLI uruchomić sesję."
    >
      {ALL_PROVIDERS.map(p => {
        const info = infos.find(i => i.provider === p);
        const isOn = enabled.includes(p);
        const isLastEnabled = isOn && enabled.length === 1;
        const labelId = `settings-providers-${p}`;
        return (
          <SettingsRow
            key={p}
            label={<ProviderLabel provider={p} />}
            labelId={labelId}
            description={info && !info.available ? <span className="text-warn">nie znaleziono w PATH</span> : undefined}
          >
            <Switch checked={isOn} disabled={isLastEnabled} onChange={() => toggle(p)} labelledBy={labelId} />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

function TitleGenSection() {
  const enabledProviders = useStore(useShallow(s => s.enabledProviders));
  const titleGenModelId = useStore(s => s.titleGenModelId);
  const setTitleGenModel = useStore(s => s.setTitleGenModel);
  const customModels = useStore(useShallow(s => s.customModels));
  const codexTitleGenModelId = useStore(s => s.codexTitleGenModelId);
  const setCodexTitleGenModel = useStore(s => s.setCodexTitleGenModel);
  const codexCustomModels = useStore(useShallow(s => s.codexCustomModels));
  const [detectedCodex, setDetectedCodex] = useState<string[]>([]);
  const opencodeTitleGenModelId = useStore(s => s.opencodeTitleGenModelId);
  const setOpencodeTitleGenModel = useStore(s => s.setOpencodeTitleGenModel);
  const opencodeCustomModels = useStore(useShallow(s => s.opencodeCustomModels));
  const [detectedOpencode, setDetectedOpencode] = useState<string[]>([]);
  const { options: claudeOptions } = useClaudeOptions();
  const claudeTitleRows = useMemo(
    () => buildClaudeModelRows(claudeOptions.models, customModels, titleGenModelId),
    [claudeOptions.models, customModels, titleGenModelId],
  );

  useEffect(() => {
    tauri.detectCodexModels().then(setDetectedCodex).catch(() => setDetectedCodex([]));
  }, []);

  useEffect(() => {
    tauri.detectOpencodeModels().then(setDetectedOpencode).catch(() => setDetectedOpencode([]));
  }, []);

  const codexOptions = Array.from(new Set([...detectedCodex, ...codexCustomModels]));
  const codexTitleGenInList = codexTitleGenModelId === '' || codexOptions.includes(codexTitleGenModelId);
  const opencodeOptions = Array.from(new Set([...detectedOpencode, ...opencodeCustomModels]));
  const opencodeTitleGenInList = opencodeTitleGenModelId === '' || opencodeOptions.includes(opencodeTitleGenModelId);

  return (
    <SettingsSection
      label="Model do generowania tytułów"
      description="Używany przy ręcznym wywołaniu „Generuj tytuł sesji” (ikona ✨ w nagłówku sesji). Zwykle wystarczy najszybszy/najtańszy model."
    >
      {enabledProviders.includes('claude') && (
        <SettingsRow label={<ProviderLabel provider="claude" />} htmlFor="settings-title-claude">
          <SelectField
            id="settings-title-claude"
            value={titleGenModelId}
            onChange={e => setTitleGenModel(e.target.value)}
          >
            <option value="">{AUTO_MODEL_LABEL}</option>
            <option value={DEFAULT_TITLE_GEN_MODEL_ID}>Haiku (najnowszy)</option>
            {claudeTitleRows.latest.map(r => (
              <option key={r.modelId} value={r.modelId}>{r.label}</option>
            ))}
            {claudeTitleRows.older.filter(r => r.modelId === titleGenModelId).map(r => (
              <option key={r.modelId} value={r.modelId}>{r.label}</option>
            ))}
            {claudeTitleRows.custom.length > 0 && <option disabled>──────────</option>}
            {claudeTitleRows.custom.map(r => (
              <option key={r.modelId} value={r.modelId}>{r.label}</option>
            ))}
            {claudeTitleRows.undetected && claudeTitleRows.undetected.modelId !== DEFAULT_TITLE_GEN_MODEL_ID && (
              <option value={claudeTitleRows.undetected.modelId}>{claudeTitleRows.undetected.label}</option>
            )}
          </SelectField>
        </SettingsRow>
      )}

      {enabledProviders.includes('codex') && (
        <SettingsRow label={<ProviderLabel provider="codex" />} htmlFor="settings-title-codex">
          <SelectField
            id="settings-title-codex"
            value={codexTitleGenModelId}
            onChange={e => setCodexTitleGenModel(e.target.value)}
          >
            <option value="">Auto (konfiguracja Codexa)</option>
            {codexOptions.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!codexTitleGenInList && (
              <option value={codexTitleGenModelId}>{codexTitleGenModelId}</option>
            )}
          </SelectField>
        </SettingsRow>
      )}

      {enabledProviders.includes('opencode') && (
        <SettingsRow label={<ProviderLabel provider="opencode" />} htmlFor="settings-title-opencode">
          <SelectField
            id="settings-title-opencode"
            value={opencodeTitleGenModelId}
            onChange={event => setOpencodeTitleGenModel(event.target.value)}
          >
            <option value="">Auto (konfiguracja OpenCode)</option>
            {opencodeOptions.map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
            {!opencodeTitleGenInList && (
              <option value={opencodeTitleGenModelId}>{opencodeTitleGenModelId}</option>
            )}
          </SelectField>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

function InstallStatus({ installedPath, error }: { installedPath: string | null; error: string | null }) {
  return (
    <>
      {installedPath && <span className="mt-1 block text-success">Zainstalowano: {installedPath}</span>}
      {error && <span className="mt-1 block text-danger">{error}</span>}
    </>
  );
}

function CliCommandRow() {
  const [installedPath, setInstalledPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doInstall = () => {
    setError(null);
    setInstalledPath(null);
    tauri.installCliCommand()
      .then(setInstalledPath)
      .catch(err => setError(String(err?.message ?? err)));
  };

  return (
    <SettingsRow
      label="Komenda terminala"
      description={
        <>
          Instaluje komendę <code className="font-mono text-fg-secondary">abeon-code</code> w{' '}
          <code className="font-mono text-fg-secondary">~/.local/bin</code>. Użyj{' '}
          <code className="font-mono text-fg-secondary">abeon-code .</code>, aby otworzyć projekt i nową sesję
          z konsoli. Upewnij się, że ten katalog jest w <code className="font-mono text-fg-secondary">PATH</code>.
          <InstallStatus installedPath={installedPath} error={error} />
        </>
      }
    >
      <button type="button" onClick={doInstall} className={BUTTON_CLASS}>
        Zainstaluj komendę
      </button>
    </SettingsRow>
  );
}

function ClaudeSkillRow() {
  const [installedPath, setInstalledPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doInstall = () => {
    setError(null);
    setInstalledPath(null);
    tauri.installClaudeSkill()
      .then(setInstalledPath)
      .catch(err => setError(String(err?.message ?? err)));
  };

  return (
    <SettingsRow
      label="Skill dla Claude Code"
      description={
        <>
          Instaluje skill <code className="font-mono text-fg-secondary">abeon-open-session</code> w{' '}
          <code className="font-mono text-fg-secondary">~/.claude/skills</code>. Pozwala agentowi uruchomić w tle nową
          sesję w innym projekcie z gotowym promptem, np. „odpal sesję w ~/projects/x i dodaj
          endpoint…”. Instaluje też (aktualizuje) komendę <code className="font-mono text-fg-secondary">abeon-code</code> w{' '}
          <code className="font-mono text-fg-secondary">~/.local/bin</code>, która musi być dostępna w{' '}
          <code className="font-mono text-fg-secondary">PATH</code>.
          <InstallStatus installedPath={installedPath} error={error} />
        </>
      }
    >
      <button type="button" onClick={doInstall} className={BUTTON_CLASS}>
        Zainstaluj skill
      </button>
    </SettingsRow>
  );
}

export function ProvidersCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.providers.label} description={SETTINGS_CATEGORIES.providers.description}>
      <ProvidersSection />
      <TitleGenSection />
      <SettingsSection label="Terminal i skill">
        <CliCommandRow />
        <ClaudeSkillRow />
      </SettingsSection>
    </SettingsPage>
  );
}
