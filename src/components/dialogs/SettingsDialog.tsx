import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import { BUILTIN_MODELS, type EffortLevel } from '../../lib/models';
import type { ThemeMode } from '../../styles/theme';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Jasny' },
  { value: 'dark', label: 'Ciemny' },
  { value: 'system', label: 'Systemowy' },
];

type SettingsTab = 'general' | 'models';

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
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-5">
          {tab === 'general' && <GeneralTab />}
          {tab === 'models' && <ModelsTab />}
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

function GeneralTab() {
  const displayName = useStore(s => s.displayName);
  const setDisplayName = useStore(s => s.setDisplayName);
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const projectsBasePath = useStore(s => s.projectsBasePath);
  const setProjectsBasePath = useStore(s => s.setProjectsBasePath);
  const skipPermissions = useStore(s => s.skipPermissions);
  const setSkipPermissions = useStore(s => s.setSkipPermissions);

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
    </div>
  );
}

function ModelsTab() {
  const defaultModelId = useStore(s => s.defaultModelId);
  const modelEfforts = useStore(s => s.modelEfforts);
  const customModels = useStore(s => s.customModels);
  const setDefaultModel = useStore(s => s.setDefaultModel);
  const setModelEffort = useStore(s => s.setModelEffort);
  const addCustomModel = useStore(s => s.addCustomModel);
  const removeCustomModel = useStore(s => s.removeCustomModel);

  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newModelId, setNewModelId] = useState('');

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
