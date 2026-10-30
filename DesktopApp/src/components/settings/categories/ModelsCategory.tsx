import { useEffect, useState, useMemo, type ReactElement, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../store';
import { Icon } from '../../shared/Icon';
import { buildClaudeModelRows, effortOptions, type ClaudeModelRow } from '../../../lib/models';
import { tauri } from '../../../lib/tauri';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import { SettingsPage } from '../controls';
import { AUTO_MODEL_LABEL, SELECT_BASE, useClaudeOptions } from './shared';

const EFFORT_LABELS: Record<string, string> = {
  low: 'Niski',
  medium: 'Średni',
  high: 'Wysoki',
  xhigh: 'Bardzo wysoki',
  max: 'Maksymalny',
};

function ClaudeModelsSection() {
  const defaultModelId = useStore(s => s.defaultModelId);
  const modelEfforts = useStore(s => s.modelEfforts);
  const customModels = useStore(useShallow(s => s.customModels));
  const setDefaultModel = useStore(s => s.setDefaultModel);
  const setModelEffort = useStore(s => s.setModelEffort);
  const addCustomModel = useStore(s => s.addCustomModel);
  const removeCustomModel = useStore(s => s.removeCustomModel);
  const { options, loaded, refreshing, refresh } = useClaudeOptions();

  const [showOlder, setShowOlder] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newModelId, setNewModelId] = useState('');

  const rows = useMemo(
    () => buildClaudeModelRows(options.models, customModels, defaultModelId),
    [options.models, customModels, defaultModelId],
  );
  const nothingDetected = loaded && options.models.length === 0;
  const advancedOpen = showAdvanced || nothingDetected;
  const visibleOlder = showOlder ? rows.older : rows.older.filter(r => r.modelId === defaultModelId);
  const pinnedCustom = advancedOpen ? [] : rows.custom.filter(r => r.modelId === defaultModelId);

  const submitCustom = () => {
    if (!newLabel.trim() || !newModelId.trim()) return;
    addCustomModel({ modelId: newModelId, label: newLabel });
    setNewLabel('');
    setNewModelId('');
    setAdding(false);
  };

  const renderRow = (row: ClaudeModelRow, extra?: { badge?: string; onRemove?: () => void }) => (
    <ModelRow
      key={row.modelId || 'auto'}
      label={row.label}
      modelId={row.modelId}
      selected={defaultModelId === row.modelId}
      effort={modelEfforts[row.modelId]}
      effortLevels={options.effortLevels}
      badge={extra?.badge}
      onSelect={() => setDefaultModel(row.modelId)}
      onEffortChange={effort => setModelEffort(row.modelId, effort)}
      onRemove={extra?.onRemove}
    />
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon name="claudeLogo" className="w-3.5 h-3.5" />
          <label className="block text-[10px] text-muted uppercase tracking-wider">Claude Code</label>
        </div>
        <button
          onClick={() => refresh(true)}
          disabled={refreshing}
          className="text-[11px] text-muted hover:text-fg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refreshing ? 'Odświeżanie…' : 'Odśwież'}
        </button>
      </div>
      <p className="text-[11px] text-muted mb-3">
        Model używany przy tworzeniu nowych sesji. Istniejące sesje zachowują swój model.
        Lista pochodzi z zainstalowanego Claude Code.
      </p>

      {nothingDetected && (
        <p className="text-[11px] text-danger mb-2">Nie wykryto modeli — sprawdź instalację Claude Code</p>
      )}

      <div className="space-y-0.5 mb-2">
        {renderRow({ modelId: '', label: AUTO_MODEL_LABEL })}
        {rows.latest.map(row => renderRow(row))}
        {visibleOlder.map(row => renderRow(row))}
        {pinnedCustom.map(row => renderRow(row))}
        {rows.undetected && renderRow(rows.undetected, { badge: 'niewykryty' })}
      </div>

      {rows.older.length > 0 && (
        <button
          onClick={() => setShowOlder(v => !v)}
          className="text-[11px] text-muted hover:text-fg transition-colors mb-4"
        >
          {showOlder ? 'Ukryj starsze wersje' : `Pokaż starsze wersje (${rows.older.length})`}
        </button>
      )}

      <div className="border-t border-border pt-3">
        <button
          onClick={() => setShowAdvanced(v => !v)}
          className="flex items-center gap-1.5 text-[10px] text-muted uppercase tracking-wider hover:text-fg transition-colors mb-2"
        >
          <span>{advancedOpen ? '▾' : '▸'}</span>
          <span>Zaawansowane</span>
        </button>

        {advancedOpen && (
          <div>
            <p className="text-[11px] text-muted mb-2">
              Modele własne — gdy wykrywanie nie znajduje potrzebnego ID (np. Bedrock/Vertex).
            </p>
            {(rows.custom.length > 0 || rows.detectedCustom.length > 0) && (
              <div className="space-y-0.5 mb-3">
                {rows.custom.map(row => renderRow(row, { onRemove: () => removeCustomModel(row.modelId) }))}
                {rows.detectedCustom.map(row => (
                  <div key={row.modelId} className="flex items-center gap-3 py-1.5 px-2">
                    <span className="text-[13px]">{row.label}</span>
                    <span className="text-[11px] text-muted font-mono truncate flex-1 min-w-0">{row.modelId}</span>
                    <span className="text-[10px] text-muted border border-border px-1.5 py-0.5 rounded">wykryty</span>
                    <button
                      onClick={() => removeCustomModel(row.modelId)}
                      className="text-muted hover:text-danger transition-colors p-1"
                      aria-label="Usuń model"
                    >
                      <Icon name="trash" className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
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
        )}
      </div>
    </div>
  );
}

type PlainModelSectionProps = {
  label: string;
  description: string;
  radioName: string;
  autoLabel: string;
  placeholder: string;
  selected: string;
  detected: string[];
  custom: string[];
  onSelect: (model: string) => void;
  onAdd: (model: string) => void;
  onRemove: (model: string) => void;
};

function PlainModelSection({
  label,
  description,
  radioName,
  autoLabel,
  placeholder,
  selected,
  detected,
  custom,
  onSelect,
  onAdd,
  onRemove,
}: PlainModelSectionProps) {
  const [newModel, setNewModel] = useState('');
  const options = Array.from(new Set([...detected, ...custom, ...(selected ? [selected] : [])]));
  const icon = label === 'Codex' ? 'openaiLogo' : 'opencodeLogo';

  const submit = () => {
    onAdd(newModel);
    setNewModel('');
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon name={icon} className="w-3.5 h-3.5" />
        <label className="block text-[10px] text-muted uppercase tracking-wider">{label}</label>
      </div>
      <p className="text-[11px] text-muted mb-3">{description}</p>
      <div className="space-y-0.5 mb-4">
        <label className={`flex items-center gap-3 py-1.5 px-2 cursor-pointer ${selected === '' ? 'bg-bg-elev-2' : 'hover:bg-bg-elev-2'}`}>
          <input type="radio" name={radioName} checked={selected === ''} onChange={() => onSelect('')} className="accent-accent" />
          <span className="text-[13px]">{autoLabel}</span>
        </label>
        {options.map(model => (
          <div key={model} className="flex items-center gap-2">
            <label className={`flex-1 flex items-center gap-3 py-1.5 px-2 cursor-pointer ${selected === model ? 'bg-bg-elev-2' : 'hover:bg-bg-elev-2'}`}>
              <input type="radio" name={radioName} checked={selected === model} onChange={() => onSelect(model)} className="accent-accent" />
              <span className="text-[13px] font-mono">{model}</span>
              {detected.includes(model) && !custom.includes(model) && (
                <span className="text-[10px] text-muted border border-border px-1.5 py-0.5 rounded">wykryty</span>
              )}
            </label>
            {custom.includes(model) && (
              <button onClick={() => onRemove(model)} className="text-muted hover:text-danger transition-colors p-1" aria-label="Usuń model">
                <Icon name="trash" className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={newModel}
          onChange={event => setNewModel(event.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-bg border border-border px-3 py-1.5 text-[13px] font-mono placeholder:text-muted/60"
          onKeyDown={event => { if (event.key === 'Enter') submit(); }}
        />
        <button
          onClick={submit}
          disabled={!newModel.trim()}
          className="px-3 py-1.5 border border-border bg-bg-elev-2 text-[12px] text-fg-secondary hover:text-fg disabled:opacity-40 shrink-0"
        >
          Dodaj
        </button>
      </div>
    </div>
  );
}

function CodexModelsSection() {
  const codexModelId = useStore(s => s.codexModelId);
  const setCodexModel = useStore(s => s.setCodexModel);
  const codexCustomModels = useStore(useShallow(s => s.codexCustomModels));
  const addCustom = useStore(s => s.addCodexCustomModel);
  const removeCustom = useStore(s => s.removeCodexCustomModel);
  const [detected, setDetected] = useState<string[]>([]);

  useEffect(() => {
    tauri.detectCodexModels().then(setDetected).catch(() => setDetected([]));
  }, []);

  return (
    <PlainModelSection
      label="Codex"
      description="Model używany przy tworzeniu nowych sesji Codex. „Auto” pozostawia wybór konfiguracji Codexa."
      radioName="codex-model"
      autoLabel="Auto (konfiguracja Codexa)"
      placeholder="np. gpt-5.5-codex"
      selected={codexModelId}
      detected={detected}
      custom={codexCustomModels}
      onSelect={setCodexModel}
      onAdd={addCustom}
      onRemove={removeCustom}
    />
  );
}

function OpencodeModelsSection() {
  const selected = useStore(s => s.opencodeModelId);
  const setSelected = useStore(s => s.setOpencodeModel);
  const custom = useStore(useShallow(s => s.opencodeCustomModels));
  const addCustom = useStore(s => s.addOpencodeCustomModel);
  const removeCustom = useStore(s => s.removeOpencodeCustomModel);
  const [detected, setDetected] = useState<string[]>([]);

  useEffect(() => {
    tauri.detectOpencodeModels().then(setDetected).catch(() => setDetected([]));
  }, []);

  return (
    <PlainModelSection
      label="OpenCode"
      description="Model używany przy tworzeniu nowych sesji OpenCode. „Auto” pozostawia wybór konfiguracji OpenCode."
      radioName="opencode-model"
      autoLabel="Auto (konfiguracja OpenCode)"
      placeholder="np. anthropic/claude-sonnet-4-5"
      selected={selected}
      detected={detected}
      custom={custom}
      onSelect={setSelected}
      onAdd={addCustom}
      onRemove={removeCustom}
    />
  );
}

function ModelsTab() {
  const enabledProviders = useStore(useShallow(s => s.enabledProviders));
  const showClaude = enabledProviders.includes('claude');
  const showCodex = enabledProviders.includes('codex');
  const showOpencode = enabledProviders.includes('opencode');
  const sections = [
    showClaude ? <ClaudeModelsSection key="claude" /> : null,
    showCodex ? <CodexModelsSection key="codex" /> : null,
    showOpencode ? <OpencodeModelsSection key="opencode" /> : null,
  ].filter((section): section is ReactElement => section !== null);

  return (
    <div>
      {sections.map((section, index) => (
        <div key={section.key} className={index > 0 ? 'border-t border-border pt-4 mt-4' : ''}>
          {section}
        </div>
      ))}
    </div>
  );
}

function ModelRow({ label, modelId, selected, effort, effortLevels, badge, onSelect, onEffortChange, onRemove }: {
  label: string;
  modelId: string;
  selected: boolean;
  effort: string | undefined;
  effortLevels: string[];
  badge?: ReactNode;
  onSelect: () => void;
  onEffortChange: (effort: string | null) => void;
  onRemove?: () => void;
}) {
  return (
    <div className={`flex items-center gap-3 py-1.5 px-2 ${selected ? 'bg-bg-elev-2' : 'hover:bg-bg-elev-2'}`}>
      <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
        <input
          type="radio"
          name="default-model"
          checked={selected}
          onChange={onSelect}
          className="accent-accent"
        />
        <span className="text-[13px]">{label}</span>
        {modelId && <span className="text-[11px] text-muted font-mono truncate">{modelId}</span>}
        {badge && (
          <span className="text-[10px] text-muted border border-border px-1.5 py-0.5 rounded">{badge}</span>
        )}
      </label>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted">Effort</span>
        <select
          aria-label={`Effort: ${label}`}
          value={effort ?? ''}
          onChange={e => onEffortChange(e.target.value || null)}
          className={`${SELECT_BASE} text-[11px] px-1.5 py-0.5`}
        >
          <option value="">Domyślny</option>
          {effortOptions(effortLevels, effort).map(level => (
            <option key={level} value={level}>{EFFORT_LABELS[level] ?? level}</option>
          ))}
        </select>
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          className="text-muted hover:text-danger transition-colors p-1"
          aria-label="Usuń model"
        >
          <Icon name="trash" className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

export function ModelsCategory() {
  return (
    <SettingsPage title={SETTINGS_CATEGORIES.models.label} description={SETTINGS_CATEGORIES.models.description}>
      <ModelsTab />
    </SettingsPage>
  );
}
