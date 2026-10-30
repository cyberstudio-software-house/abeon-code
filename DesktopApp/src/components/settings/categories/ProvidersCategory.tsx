import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../store';
import { Icon } from '../../shared/Icon';
import { buildClaudeModelRows, DEFAULT_TITLE_GEN_MODEL_ID } from '../../../lib/models';
import { tauri } from '../../../lib/tauri';
import type { ProviderInfo } from '../../../types';
import { ALL_PROVIDERS, PROVIDER_LABEL, PROVIDER_ICON } from '../../../lib/providers';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage } from '../controls';
import { AUTO_MODEL_LABEL, useClaudeOptions } from './shared';

function ProvidersSection() {
  const enabled = useStore(useShallow(s => s.enabledProviders));
  const toggle = useStore(s => s.toggleProvider);
  const [infos, setInfos] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    tauri.detectProviders().then(setInfos).catch(() => setInfos([]));
  }, []);

  return (
    <div>
      <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
        Dostawcy CLI
      </label>
      <div className="space-y-0.5">
        {ALL_PROVIDERS.map(p => {
          const info = infos.find(i => i.provider === p);
          const isOn = enabled.includes(p);
          const isLastEnabled = isOn && enabled.length === 1;
          return (
            <label key={p} className="flex items-start gap-3 cursor-pointer py-1.5 px-2 hover:bg-bg-elev-2">
              <input
                type="checkbox"
                checked={isOn}
                disabled={isLastEnabled}
                onChange={() => toggle(p)}
                className="accent-accent mt-0.5"
              />
              <div className="flex items-center gap-2">
                <Icon name={PROVIDER_ICON[p]} className="w-3.5 h-3.5" />
                <span className="text-[13px]">{PROVIDER_LABEL[p]}</span>
                {info && !info.available && (
                  <span className="text-[11px] text-warn">nie znaleziono w PATH</span>
                )}
              </div>
            </label>
          );
        })}
      </div>
      <p className="text-[11px] text-muted mt-2">
        Gdy włączony jest więcej niż jeden dostawca, „New session" najpierw pyta, w którym CLI uruchomić sesję.
      </p>
    </div>
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
    <div>
      <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
        Model do generowania tytułów
      </label>
      <p className="text-[11px] text-muted mb-3">
        Używany przy ręcznym wywołaniu „Generuj tytuł sesji" (ikona ✨ w nagłówku sesji).
        Zwykle wystarczy najszybszy/najtańszy model.
      </p>

      {enabledProviders.includes('claude') && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2">
            <Icon name="claudeLogo" className="w-3.5 h-3.5" />
            <span className="text-[12px] text-fg-secondary">Claude Code</span>
          </div>
          <select
            value={titleGenModelId}
            onChange={e => setTitleGenModel(e.target.value)}
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] text-fg"
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
          </select>
        </div>
      )}

      {enabledProviders.includes('codex') && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2">
            <Icon name="openaiLogo" className="w-3.5 h-3.5" />
            <span className="text-[12px] text-fg-secondary">Codex</span>
          </div>
          <select
            value={codexTitleGenModelId}
            onChange={e => setCodexTitleGenModel(e.target.value)}
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] text-fg"
          >
            <option value="">Auto (konfiguracja Codexa)</option>
            {codexOptions.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!codexTitleGenInList && (
              <option value={codexTitleGenModelId}>{codexTitleGenModelId}</option>
            )}
          </select>
        </div>
      )}

      {enabledProviders.includes('opencode') && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Icon name="opencodeLogo" className="w-3.5 h-3.5" />
            <span className="text-[12px] text-fg-secondary">OpenCode</span>
          </div>
          <select
            value={opencodeTitleGenModelId}
            onChange={event => setOpencodeTitleGenModel(event.target.value)}
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] text-fg"
          >
            <option value="">Auto (konfiguracja OpenCode)</option>
            {opencodeOptions.map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
            {!opencodeTitleGenInList && (
              <option value={opencodeTitleGenModelId}>{opencodeTitleGenModelId}</option>
            )}
          </select>
        </div>
      )}
    </div>
  );
}

function CliCommandSection() {
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
    <div className="space-y-2">
      <h3 className="text-[12px] font-semibold text-fg">Komenda terminala</h3>
      <p className="text-[11px] text-muted">
        Instaluje komendę <code className="mx-1">abeon-code</code> w
        <code className="mx-1">~/.local/bin</code>. Użyj
        <code className="mx-1">abeon-code .</code>, aby otworzyć projekt i nową sesję
        z konsoli. Upewnij się, że ten katalog jest w <code>PATH</code>.
      </p>
      <button onClick={doInstall} className="text-accent underline text-[12px]">
        Zainstaluj komendę
      </button>
      {installedPath && (
        <p className="text-[11px] text-success">Zainstalowano: {installedPath}</p>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

function ClaudeSkillSection() {
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
    <div className="space-y-2">
      <h3 className="text-[12px] font-semibold text-fg">Skill dla Claude Code</h3>
      <p className="text-[11px] text-muted">
        Instaluje skill <code className="mx-1">abeon-open-session</code> w
        <code className="mx-1">~/.claude/skills</code>. Pozwala agentowi uruchomić w tle nową
        sesję w innym projekcie z gotowym promptem, np. „odpal sesję w ~/projects/x i dodaj
        endpoint…”. Instaluje też (aktualizuje) komendę <code>abeon-code</code> w
        <code className="mx-1">~/.local/bin</code>, która musi być dostępna w <code>PATH</code>.
      </p>
      <button onClick={doInstall} className="text-accent underline text-[12px]">
        Zainstaluj skill
      </button>
      {installedPath && (
        <p className="text-[11px] text-success">Zainstalowano: {installedPath}</p>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

function CliTab() {
  return (
    <div className="space-y-6">
      <ProvidersSection />
      <TitleGenSection />
      <CliCommandSection />
      <ClaudeSkillSection />
    </div>
  );
}

export function ProvidersCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.providers.label} description={SETTINGS_CATEGORIES.providers.description}>
      <CliTab />
    </SettingsPage>
  );
}
