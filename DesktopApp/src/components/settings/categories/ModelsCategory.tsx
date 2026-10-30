import { useEffect, useState, useMemo, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../../store';
import { Icon, type IconName } from '../../shared/Icon';
import { buildClaudeModelRows, effortOptions, type ClaudeModelRow } from '../../../lib/models';
import { tauri } from '../../../lib/tauri';
import { SETTINGS_CATEGORIES } from '../../../lib/settingsCategories';
import {
  BUTTON_CLASS, FIELD_CLASS, MONO_FIELD_CLASS, PRIMARY_BUTTON_CLASS, SelectField, SettingsPage, SettingsRow, SettingsSection,
} from '../controls';
import { AUTO_MODEL_LABEL, useClaudeOptions } from './shared';

const EFFORT_LABELS: Record<string, string> = {
  low: 'Niski',
  medium: 'Średni',
  high: 'Wysoki',
  xhigh: 'Bardzo wysoki',
  max: 'Maksymalny',
};

const BADGE_CLASS = 'rounded border border-border-strong px-1.5 py-0.5 text-[10px] text-muted';
const ICON_BUTTON_CLASS = 'grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-icon transition-colors hover:text-danger';
const TEXT_BUTTON_CLASS = 'text-[12px] text-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50';

function SectionTitle({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <>
      <Icon name={icon} className="h-3.5 w-3.5" />
      {children}
    </>
  );
}

function RadioRow({ name, checked, onSelect, label, detail, badge, trailing }: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: ReactNode;
  detail?: string;
  badge?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-6 gap-y-2 px-[18px] py-3 transition-colors ${
        checked ? 'bg-bg-elev-2' : 'hover:bg-bg-elev-2'
      }`}
    >
      <label className="flex min-w-0 flex-[1_1_240px] cursor-pointer items-center gap-3">
        <input type="radio" name={name} checked={checked} onChange={onSelect} className="accent-accent" />
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span data-settings-row-label="" className="text-[13.5px] font-medium text-fg-strong">{label}</span>
          {detail && <span className="truncate font-mono text-[12px] text-muted">{detail}</span>}
          {badge && <span className={BADGE_CLASS}>{badge}</span>}
        </span>
      </label>
      {trailing}
    </div>
  );
}

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
    <SettingsSection
      label={<SectionTitle icon="claudeLogo">Claude Code</SectionTitle>}
      description={
        <>
          Model używany przy tworzeniu nowych sesji. Istniejące sesje zachowują swój model.
          Lista pochodzi z zainstalowanego Claude Code.
          {nothingDetected && (
            <span className="mt-1 block text-danger">Nie wykryto modeli — sprawdź instalację Claude Code</span>
          )}
        </>
      }
      action={
        <button type="button" onClick={() => refresh(true)} disabled={refreshing} className={TEXT_BUTTON_CLASS}>
          {refreshing ? 'Odświeżanie…' : 'Odśwież'}
        </button>
      }
    >
      {renderRow({ modelId: '', label: AUTO_MODEL_LABEL })}
      {rows.latest.map(row => renderRow(row))}
      {visibleOlder.map(row => renderRow(row))}
      {pinnedCustom.map(row => renderRow(row))}
      {rows.undetected && renderRow(rows.undetected, { badge: 'niewykryty' })}

      {rows.older.length > 0 && (
        <div className="px-[18px] py-2.5">
          <button type="button" onClick={() => setShowOlder(v => !v)} className={TEXT_BUTTON_CLASS}>
            {showOlder ? 'Ukryj starsze wersje' : `Pokaż starsze wersje (${rows.older.length})`}
          </button>
        </div>
      )}

      <div className="px-[18px] py-2.5">
        <button
          type="button"
          onClick={() => setShowAdvanced(v => !v)}
          className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-label transition-colors hover:text-fg"
        >
          <span>{advancedOpen ? '▾' : '▸'}</span>
          <span>Zaawansowane</span>
        </button>
      </div>

      {advancedOpen && (
        <>
          <p className="px-[18px] py-3 text-[12px] leading-[1.5] text-muted">
            Modele własne — gdy wykrywanie nie znajduje potrzebnego ID (np. Bedrock/Vertex).
          </p>
          {rows.custom.map(row => renderRow(row, { onRemove: () => removeCustomModel(row.modelId) }))}
          {rows.detectedCustom.map(row => (
            <div key={row.modelId} className="flex items-center gap-3 px-[18px] py-3">
              <span className="text-[13.5px] font-medium text-fg-strong">{row.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{row.modelId}</span>
              <span className={BADGE_CLASS}>wykryty</span>
              <button
                type="button"
                onClick={() => removeCustomModel(row.modelId)}
                className={ICON_BUTTON_CLASS}
                aria-label="Usuń model"
              >
                <Icon name="trash" className="h-3 w-3" />
              </button>
            </div>
          ))}
          {adding ? (
            <>
              <SettingsRow label="Nazwa" htmlFor="settings-models-new-label">
                <input
                  id="settings-models-new-label"
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  placeholder="np. My Fine-tuned Model"
                  className={`${FIELD_CLASS} flex-[0_1_280px]`}
                  autoFocus
                />
              </SettingsRow>
              <SettingsRow label="ID modelu (CLI)" htmlFor="settings-models-new-id">
                <input
                  id="settings-models-new-id"
                  value={newModelId}
                  onChange={e => setNewModelId(e.target.value)}
                  placeholder="np. claude-sonnet-4-6"
                  className={`${MONO_FIELD_CLASS} flex-[0_1_280px]`}
                  onKeyDown={e => { if (e.key === 'Enter') submitCustom(); }}
                />
              </SettingsRow>
              <div className="flex justify-end gap-2 px-[18px] py-3">
                <button
                  type="button"
                  onClick={() => { setAdding(false); setNewLabel(''); setNewModelId(''); }}
                  className={BUTTON_CLASS}
                >
                  Anuluj
                </button>
                <button
                  type="button"
                  onClick={submitCustom}
                  disabled={!newLabel.trim() || !newModelId.trim()}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  Dodaj
                </button>
              </div>
            </>
          ) : (
            <div className="px-[18px] py-3">
              <button type="button" onClick={() => setAdding(true)} className={BUTTON_CLASS}>
                <Icon name="plus" className="h-3 w-3" strokeWidth={2.5} />
                Dodaj własny model
              </button>
            </div>
          )}
        </>
      )}
    </SettingsSection>
  );
}

type PlainModelSectionProps = {
  label: string;
  icon: IconName;
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
  icon,
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

  const submit = () => {
    onAdd(newModel);
    setNewModel('');
  };

  return (
    <SettingsSection label={<SectionTitle icon={icon}>{label}</SectionTitle>} description={description}>
      <RadioRow name={radioName} checked={selected === ''} onSelect={() => onSelect('')} label={autoLabel} />
      {options.map(model => (
        <RadioRow
          key={model}
          name={radioName}
          checked={selected === model}
          onSelect={() => onSelect(model)}
          label={<span className="font-mono text-[13px]">{model}</span>}
          badge={detected.includes(model) && !custom.includes(model) ? 'wykryty' : undefined}
          trailing={custom.includes(model) ? (
            <button type="button" onClick={() => onRemove(model)} className={ICON_BUTTON_CLASS} aria-label="Usuń model">
              <Icon name="trash" className="h-3 w-3" />
            </button>
          ) : undefined}
        />
      ))}
      <div className="flex gap-2 px-[18px] py-3">
        <input
          aria-label={`Własny model ${label}`}
          value={newModel}
          onChange={event => setNewModel(event.target.value)}
          placeholder={placeholder}
          className={`${MONO_FIELD_CLASS} flex-1`}
          onKeyDown={event => { if (event.key === 'Enter') submit(); }}
        />
        <button type="button" onClick={submit} disabled={!newModel.trim()} className={BUTTON_CLASS}>
          Dodaj
        </button>
      </div>
    </SettingsSection>
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
      icon="openaiLogo"
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
      icon="opencodeLogo"
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
    <RadioRow
      name="default-model"
      checked={selected}
      onSelect={onSelect}
      label={label}
      detail={modelId || undefined}
      badge={badge}
      trailing={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">Effort</span>
          <SelectField
            aria-label={`Effort: ${label}`}
            wrapperClassName="w-[150px]"
            value={effort ?? ''}
            onChange={e => onEffortChange(e.target.value || null)}
          >
            <option value="">Domyślny</option>
            {effortOptions(effortLevels, effort).map(level => (
              <option key={level} value={level}>{EFFORT_LABELS[level] ?? level}</option>
            ))}
          </SelectField>
          {onRemove && (
            <button type="button" onClick={onRemove} className={ICON_BUTTON_CLASS} aria-label="Usuń model">
              <Icon name="trash" className="h-3 w-3" />
            </button>
          )}
        </div>
      }
    />
  );
}

export function ModelsCategory() {
  const enabledProviders = useStore(useShallow(s => s.enabledProviders));

  return (
    <SettingsPage title={SETTINGS_CATEGORIES.models.label} description={SETTINGS_CATEGORIES.models.description}>
      {enabledProviders.includes('claude') && <ClaudeModelsSection />}
      {enabledProviders.includes('codex') && <CodexModelsSection />}
      {enabledProviders.includes('opencode') && <OpencodeModelsSection />}
    </SettingsPage>
  );
}
