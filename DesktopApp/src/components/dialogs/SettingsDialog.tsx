import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { PairingDialog } from './PairingDialog';
import { open } from '@tauri-apps/plugin-dialog';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import { BUILTIN_MODELS, detectUnknownModels, type EffortLevel, type DetectedSuggestion } from '../../lib/models';
import type { ThemeMode } from '../../styles/theme';
import { tauri } from '../../lib/tauri';
import type { ShellInfo, EditorInfo, DetectedModel, ProviderInfo } from '../../types';
import { ALL_PROVIDERS, PROVIDER_LABEL, PROVIDER_ICON } from '../../lib/providers';
import {
  SHORTCUTS, FIXED_SHORTCUTS, getBinding, formatBinding, eventToBinding,
  type ShortcutId,
} from '../../lib/shortcuts';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Jasny' },
  { value: 'dark', label: 'Ciemny' },
  { value: 'system', label: 'Systemowy' },
];

type SettingsTab = 'general' | 'models' | 'shortcuts';

const EFFORT_OPTIONS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Niski' },
  { value: 'medium', label: 'Średni' },
  { value: 'high', label: 'Wysoki' },
];

export function SettingsDialog() {
  const [tab, setTab] = useState<SettingsTab>('general');
  const closeSettings = useStore(s => s.closeSettings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSettings(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeSettings]);

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={closeSettings}>
      <div
        className="bg-bg-elev border border-border w-[560px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-[14px] font-semibold">Ustawienia</h2>
          <button onClick={closeSettings} className="text-muted hover:text-fg transition-colors">
            <Icon name="close" className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-1 px-5 border-b border-border">
          <TabButton active={tab === 'general'} onClick={() => setTab('general')}>Ogólne</TabButton>
          <TabButton active={tab === 'models'} onClick={() => setTab('models')}>Modele</TabButton>
          <TabButton active={tab === 'shortcuts'} onClick={() => setTab('shortcuts')}>Skróty</TabButton>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-5">
          {tab === 'general' && <GeneralTab />}
          {tab === 'models' && <ModelsTab />}
          {tab === 'shortcuts' && <ShortcutsTab />}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors -mb-px ${
        active
          ? 'border-accent text-fg'
          : 'border-transparent text-muted hover:text-fg-secondary'
      }`}
    >
      {children}
    </button>
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

function GeneralTab() {
  const displayName = useStore(s => s.displayName);
  const setDisplayName = useStore(s => s.setDisplayName);
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const projectsBasePath = useStore(s => s.projectsBasePath);
  const setProjectsBasePath = useStore(s => s.setProjectsBasePath);
  const skipPermissions = useStore(s => s.skipPermissions);
  const setSkipPermissions = useStore(s => s.setSkipPermissions);
  const shellPath = useStore(s => s.shellPath);
  const setShellPath = useStore(s => s.setShellPath);
  const editorPath = useStore(s => s.editorPath);
  const setEditorPath = useStore(s => s.setEditorPath);
  const historyViewMode = useStore(s => s.historyViewMode);
  const setHistoryViewMode = useStore(s => s.setHistoryViewMode);
  const remoteBridgeEnabled = useStore(s => s.remoteBridgeEnabled);
  const setRemoteBridgeEnabled = useStore(s => s.setRemoteBridgeEnabled);
  const allowRemoteSpawn = useStore(s => s.allowRemoteSpawn);
  const setAllowRemoteSpawn = useStore(s => s.setAllowRemoteSpawn);
  const cloudServiceUrl = useStore(s => s.cloudServiceUrl);
  const setCloudServiceUrl = useStore(s => s.setCloudServiceUrl);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [detectedName, setDetectedName] = useState<string | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [editorCustomMode, setEditorCustomMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, detected, editorList] = await Promise.all([
          tauri.listAvailableShells(),
          tauri.detectDefaultShell(),
          tauri.listAvailableEditors(),
        ]);
        if (cancelled) return;
        setShells(list);
        setEditors(editorList);
        if (detected) {
          const match = list.find(s => s.path === detected || s.name === detected);
          setDetectedName(match?.name ?? detected);
        }
      } catch (err) {
        console.error('[settings] failed to load shells/editors', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isCustom = shellPath !== '' && !shells.some(s => s.name === shellPath || s.path === shellPath);
  const showCustom = isCustom || customMode;
  const isEditorCustom = editorPath !== '' && !editors.some(s => s.name === editorPath || s.path === editorPath);
  const showEditorCustom = isEditorCustom || editorCustomMode;

  const pickProjectsBase = async () => {
    const sel = await open({
      directory: true,
      multiple: false,
      defaultPath: projectsBasePath || undefined,
    });
    if (typeof sel === 'string') setProjectsBasePath(sel);
  };

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
          Nazwa wyświetlana
        </label>
        <input
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder="Domyślnie z konfiguracji Git"
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] placeholder:text-muted/60"
        />
        <p className="text-[11px] text-muted mt-2">
          Wyświetlana w stopce panelu bocznego. Puste pole oznacza użycie nazwy z Git.
        </p>
      </div>

      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
          Ścieżka bazowa projektów
        </label>
        <div className="flex gap-2">
          <input
            value={projectsBasePath}
            onChange={e => setProjectsBasePath(e.target.value)}
            placeholder="Nie ustawiono"
            className="flex-1 bg-bg border border-border px-3 py-1.5 text-[13px] font-mono placeholder:text-muted/60"
          />
          <button
            onClick={pickProjectsBase}
            className="px-3 py-1.5 border border-border bg-bg-elev-2 text-[12px] text-fg-secondary hover:text-fg shrink-0"
          >
            Wybierz…
          </button>
        </div>
        <p className="text-[11px] text-muted mt-2">
          Katalog, od którego rozpoczyna się wybieranie folderu przy dodawaniu nowego projektu.
        </p>
      </div>

      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
          Motyw
        </label>
        <div className="flex gap-1">
          {THEME_OPTIONS.map(o => (
            <button
              key={o.value}
              onClick={() => setTheme(o.value)}
              className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                theme === o.value
                  ? 'bg-fg text-bg border-fg'
                  : 'bg-bg border-border text-muted hover:text-fg'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted mt-2">
          Opcja „Systemowy" automatycznie dostosowuje motyw do ustawień systemu operacyjnego.
        </p>
      </div>

      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
          Domyślny shell
        </label>
        <select
          value={showCustom ? '__custom__' : shellPath}
          onChange={e => {
            const v = e.target.value;
            if (v === '__custom__') {
              setCustomMode(true);
            } else {
              setCustomMode(false);
              setShellPath(v);
            }
          }}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] text-fg"
        >
          <option value="">Auto (z $SHELL)</option>
          {shells.map(s => (
            <option key={s.path} value={s.name}>{s.name} ({s.path})</option>
          ))}
          <option value="__custom__">Inny…</option>
        </select>
        {showCustom && (
          <input
            value={shellPath}
            onChange={e => setShellPath(e.target.value)}
            placeholder="/opt/homebrew/bin/fish"
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono mt-2"
          />
        )}
        <p className="text-[11px] text-muted mt-2">
          {detectedName
            ? <>Wykryto: <code className="font-mono text-fg-secondary">{detectedName}</code>. </>
            : null}
          Dotyczy tylko interaktywnych terminali (tab Shell).
        </p>
      </div>

      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
          Domyślny edytor
        </label>
        <select
          value={showEditorCustom ? '__custom__' : editorPath}
          onChange={e => {
            const v = e.target.value;
            if (v === '__custom__') {
              setEditorCustomMode(true);
            } else {
              setEditorCustomMode(false);
              setEditorPath(v);
            }
          }}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] text-fg"
        >
          <option value="">Auto (pierwszy wykryty)</option>
          {editors.map(s => (
            <option key={s.path} value={s.name}>{s.name} ({s.path})</option>
          ))}
          <option value="__custom__">Inny…</option>
        </select>
        {showEditorCustom && (
          <input
            value={editorPath}
            onChange={e => setEditorPath(e.target.value)}
            placeholder="/usr/bin/code"
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono mt-2"
          />
        )}
        <p className="text-[11px] text-muted mt-2">
          {editors.length > 0
            ? <>Wykryto: {editors.map(s => s.name).join(', ')}. </>
            : null}
          Edytor używany do otwierania projektów z panelu bocznego.
        </p>
      </div>

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

      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
          Domyślny widok historii
        </label>
        <div className="flex gap-1">
          <button
            onClick={() => setHistoryViewMode('communication')}
            className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
              historyViewMode === 'communication'
                ? 'bg-fg text-bg border-fg'
                : 'bg-bg border-border text-muted hover:text-fg'
            }`}
          >
            Komunikacja
          </button>
          <button
            onClick={() => setHistoryViewMode('full')}
            className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
              historyViewMode === 'full'
                ? 'bg-fg text-bg border-fg'
                : 'bg-bg border-border text-muted hover:text-fg'
            }`}
          >
            Pełny
          </button>
        </div>
        <p className="text-[11px] text-muted mt-2">
          Tryb „Komunikacja" pokazuje tylko wiadomości użytkownika i asystenta.
          „Pełny" zawiera też narzędzia, hooki i zdarzenia systemowe.
        </p>
      </div>

      <ProvidersSection />

      <div>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
          AbeonCloud (zdalne sterowanie)
        </label>
        <label className="flex items-start gap-3 cursor-pointer py-1.5 px-2 hover:bg-bg-elev-2">
          <input
            type="checkbox"
            checked={remoteBridgeEnabled}
            onChange={e => setRemoteBridgeEnabled(e.target.checked)}
            className="accent-accent mt-0.5"
          />
          <div>
            <span className="text-[13px]">Włącz zdalny most</span>
            <p className="text-[11px] text-muted mt-0.5">
              Wymaga restartu aplikacji.
            </p>
          </div>
        </label>
        <label className="flex items-start gap-3 cursor-pointer py-1.5 px-2 hover:bg-bg-elev-2">
          <input
            type="checkbox"
            checked={allowRemoteSpawn}
            onChange={e => setAllowRemoteSpawn(e.target.checked)}
            className="accent-accent mt-0.5"
          />
          <div>
            <span className="text-[13px]">Zezwól na zdalne wznawianie sesji</span>
          </div>
        </label>
        <div className="mt-2">
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">
            Adres CloudService
          </label>
          <input
            type="text"
            value={cloudServiceUrl}
            onChange={e => setCloudServiceUrl(e.target.value)}
            placeholder="https://cloud.k8s.abeon.app"
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono placeholder:text-muted/60"
          />
        </div>
        <button
          onClick={() => setPairingOpen(true)}
          className="mt-3 px-3 py-1.5 bg-fg text-bg text-[12px] font-medium"
        >
          Sparuj telefon
        </button>
      </div>

      {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} />}
    </div>
  );
}

function ModelsTab() {
  const defaultModelId = useStore(s => s.defaultModelId);
  const titleGenModelId = useStore(s => s.titleGenModelId);
  const modelEfforts = useStore(s => s.modelEfforts);
  const customModels = useStore(useShallow(s => s.customModels));
  const setDefaultModel = useStore(s => s.setDefaultModel);
  const setTitleGenModel = useStore(s => s.setTitleGenModel);
  const setModelEffort = useStore(s => s.setModelEffort);
  const addCustomModel = useStore(s => s.addCustomModel);
  const removeCustomModel = useStore(s => s.removeCustomModel);

  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newModelId, setNewModelId] = useState('');

  const [detected, setDetected] = useState<DetectedModel[]>([]);
  const refreshDetected = useCallback((force?: boolean) => {
    tauri.detectModels(force).then(setDetected).catch(() => setDetected([]));
  }, []);
  useEffect(() => { refreshDetected(); }, [refreshDetected]);
  const suggestions = useMemo<DetectedSuggestion[]>(
    () => detectUnknownModels(detected, customModels),
    [detected, customModels],
  );

  const promoteSuggestion = (s: DetectedSuggestion) => {
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    addCustomModel({ id, modelId: s.modelId, label: s.label });
  };

  const submitCustom = () => {
    const label = newLabel.trim();
    const modelId = newModelId.trim();
    if (!label || !modelId) return;
    const id = `custom-${crypto.randomUUID().slice(0, 8)}`;
    addCustomModel({ id, modelId, label });
    setNewLabel('');
    setNewModelId('');
    setAdding(false);
  };

  return (
    <div>
      <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
        Domyślny model
      </label>
      <p className="text-[11px] text-muted mb-3">
        Model używany przy tworzeniu nowych sesji. Istniejące sesje zachowują swój model.
      </p>

      <div className="space-y-0.5 mb-4">
        {BUILTIN_MODELS.map(m => (
          <ModelRow
            key={m.id}
            label={m.label}
            context={m.context}
            selected={defaultModelId === m.id}
            effort={m.supportsEffort ? (modelEfforts[m.id] ?? 'medium') : undefined}
            onSelect={() => setDefaultModel(m.id)}
            onEffortChange={m.supportsEffort ? (e) => setModelEffort(m.id, e) : undefined}
          />
        ))}
      </div>

      {customModels.length > 0 && (
        <>
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
            Modele własne
          </label>
          <div className="space-y-0.5 mb-4">
            {customModels.map(m => (
              <div key={m.id} className="flex items-center gap-2">
                <label className="flex-1 flex items-center gap-3 py-1.5 px-2 hover:bg-bg-elev-2 cursor-pointer">
                  <input
                    type="radio"
                    name="default-model"
                    checked={defaultModelId === m.id}
                    onChange={() => setDefaultModel(m.id)}
                    className="accent-accent"
                  />
                  <div>
                    <span className="text-[13px]">{m.label}</span>
                    <span className="text-[11px] text-muted ml-2 font-mono">{m.modelId}</span>
                  </div>
                </label>
                <button
                  onClick={() => removeCustomModel(m.id)}
                  className="text-muted hover:text-danger transition-colors p-1"
                  aria-label="Usuń model"
                >
                  <Icon name="trash" className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {suggestions.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-[10px] text-muted uppercase tracking-wider">
              Wykryte modele
            </label>
            <button
              onClick={() => refreshDetected(true)}
              className="text-[11px] text-muted hover:text-fg transition-colors"
            >
              Odśwież
            </button>
          </div>
          <p className="text-[11px] text-muted mb-2">
            Nowsze modele wykryte w Claude Code, których nie ma jeszcze na liście.
          </p>
          <div className="space-y-0.5 mb-4">
            {suggestions.map(s => (
              <div key={s.modelId} className="flex items-center gap-2 py-1.5 px-2">
                <div className="flex-1">
                  <span className="text-[13px]">{s.label}</span>
                  <span className="text-[11px] text-muted ml-2 font-mono">{s.modelId}</span>
                </div>
                <button
                  onClick={() => promoteSuggestion(s)}
                  className="flex items-center gap-1 text-[12px] text-muted hover:text-fg transition-colors"
                >
                  <Icon name="plus" className="w-3 h-3" />
                  Dodaj
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="border-t border-border pt-4 mb-4">
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
          Model do generowania tytułów
        </label>
        <p className="text-[11px] text-muted mb-2">
          Używany przy ręcznym wywołaniu „Generuj tytuł sesji" (ikona ✨ w nagłówku sesji).
          Zwykle wystarczy najszybszy/najtańszy model.
        </p>
        <select
          value={titleGenModelId}
          onChange={e => setTitleGenModel(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] text-fg"
        >
          {BUILTIN_MODELS.map(m => (
            <option key={m.id} value={m.id}>
              {m.label}{m.context ? ` (${m.context})` : ''}
            </option>
          ))}
          {customModels.length > 0 && <option disabled>──────────</option>}
          {customModels.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {adding ? (
        <div className="border border-border p-3 space-y-2">
          <label className="block text-[10px] text-muted uppercase tracking-wider">Nazwa</label>
          <input
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            placeholder="np. My Fine-tuned Model"
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px]"
            autoFocus
          />
          <label className="block text-[10px] text-muted uppercase tracking-wider">ID modelu (CLI)</label>
          <input
            value={newModelId}
            onChange={e => setNewModelId(e.target.value)}
            placeholder="np. claude-sonnet-4-6"
            className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] font-mono"
            onKeyDown={e => { if (e.key === 'Enter') submitCustom(); }}
          />
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => { setAdding(false); setNewLabel(''); setNewModelId(''); }}
              className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg"
            >
              Anuluj
            </button>
            <button
              onClick={submitCustom}
              disabled={!newLabel.trim() || !newModelId.trim()}
              className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-40"
            >
              Dodaj
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 text-[12px] text-muted hover:text-fg transition-colors"
        >
          <Icon name="plus" className="w-3 h-3" />
          Dodaj własny model
        </button>
      )}
    </div>
  );
}

function ShortcutsTab() {
  const overrides = useStore(s => s.shortcutOverrides);
  const setOverride = useStore(s => s.setShortcutOverride);
  const resetAll = useStore(s => s.resetShortcutOverrides);
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const recordRef = useRef<HTMLButtonElement | null>(null);

  const hasOverrides = Object.keys(overrides).length > 0;

  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecordingId(null);
        setConflict(null);
        return;
      }

      const binding = eventToBinding(e);
      if (!binding) return;

      const conflicting = SHORTCUTS.find(
        s => s.id !== recordingId && getBinding(s.id, overrides) === binding,
      );
      if (conflicting) {
        setConflict(conflicting.label);
        return;
      }

      const isActionKey = /^mod\+[1-9]$/.test(binding);
      if (isActionKey) {
        setConflict('Akcja 1–9');
        return;
      }

      const def = SHORTCUTS.find(s => s.id === recordingId);
      if (def && binding === def.defaultBinding) {
        const { [recordingId]: _, ...rest } = overrides;
        useStore.setState({ shortcutOverrides: rest });
      } else {
        setOverride(recordingId, binding);
      }
      setRecordingId(null);
      setConflict(null);
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [recordingId, overrides, setOverride]);

  useEffect(() => {
    if (recordingId && recordRef.current) recordRef.current.focus();
  }, [recordingId]);

  return (
    <div>
      <label className="block text-[10px] text-muted uppercase tracking-wider mb-3">
        Skróty klawiszowe
      </label>

      <div className="space-y-0.5">
        {SHORTCUTS.map(s => {
          const current = getBinding(s.id, overrides);
          const isRecording = recordingId === s.id;
          const isOverridden = !!overrides[s.id];

          return (
            <div
              key={s.id}
              className="flex items-center gap-3 py-2 px-2 hover:bg-bg-elev-2"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px]">{s.label}</div>
                <div className="text-[11px] text-muted">{s.description}</div>
              </div>
              <button
                ref={isRecording ? recordRef : undefined}
                onClick={() => {
                  setRecordingId(isRecording ? null : s.id);
                  setConflict(null);
                }}
                className={`font-mono text-[12px] px-3 py-1 border min-w-[100px] text-center transition-colors ${
                  isRecording
                    ? 'border-accent bg-accent/10 text-accent animate-pulse'
                    : isOverridden
                      ? 'border-accent/50 text-fg hover:border-accent'
                      : 'border-border text-fg-secondary hover:border-fg-secondary'
                }`}
              >
                {isRecording ? 'Naciśnij…' : formatBinding(current)}
              </button>
              {isOverridden && !isRecording && (
                <button
                  onClick={() => {
                    const { [s.id]: _, ...rest } = overrides;
                    useStore.setState({ shortcutOverrides: rest });
                  }}
                  className="text-muted hover:text-fg transition-colors p-1"
                  title="Przywróć domyślny"
                >
                  <Icon name="close" className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {conflict && (
        <p className="text-[11px] text-danger mt-2 px-2">
          Konflikt ze skrótem: {conflict}. Wybierz inną kombinację.
        </p>
      )}

      <div className="border-t border-border mt-4 pt-4">
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-3">
          Stałe skróty
        </label>
        <div className="space-y-0.5">
          {FIXED_SHORTCUTS.map(s => (
            <div key={s.label} className="flex items-center gap-3 py-2 px-2">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-fg-secondary">{s.label}</div>
                <div className="text-[11px] text-muted">{s.description}</div>
              </div>
              <span className="font-mono text-[12px] px-3 py-1 border border-border text-muted min-w-[100px] text-center">
                {formatBinding(s.binding)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {hasOverrides && (
        <div className="mt-4 pt-3 border-t border-border">
          <button
            onClick={resetAll}
            className="text-[12px] text-muted hover:text-danger transition-colors"
          >
            Przywróć wszystkie domyślne skróty
          </button>
        </div>
      )}
    </div>
  );
}

function ModelRow({ label, context, selected, effort, onSelect, onEffortChange }: {
  label: string;
  context?: string;
  selected: boolean;
  effort?: EffortLevel;
  onSelect: () => void;
  onEffortChange?: (effort: EffortLevel) => void;
}) {
  return (
    <div className={`flex items-center gap-3 py-1.5 px-2 ${selected ? 'bg-bg-elev-2' : 'hover:bg-bg-elev-2'}`}>
      <label className="flex items-center gap-3 flex-1 cursor-pointer">
        <input
          type="radio"
          name="default-model"
          checked={selected}
          onChange={onSelect}
          className="accent-accent"
        />
        <span className="text-[13px]">{label}</span>
        {context && (
          <span className="text-[10px] text-muted font-mono border border-border px-1.5 py-0.5 rounded">
            {context}
          </span>
        )}
      </label>

      {effort !== undefined && onEffortChange && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted">Effort</span>
          <select
            value={effort}
            onChange={e => onEffortChange(e.target.value as EffortLevel)}
            className="bg-bg border border-border text-[11px] px-1.5 py-0.5 text-fg-secondary"
          >
            {EFFORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
