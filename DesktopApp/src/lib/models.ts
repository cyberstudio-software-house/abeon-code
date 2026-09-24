import type { DetectedModel } from '../types';

export type EffortLevel = 'low' | 'medium' | 'high';

export type BuiltinModel = {
  id: string;
  modelId: string;
  label: string;
  context?: string;
  supportsEffort: boolean;
};

export type CustomModel = {
  id: string;
  modelId: string;
  label: string;
};

export const BUILTIN_MODELS: BuiltinModel[] = [
  { id: 'fable-5', modelId: 'claude-fable-5', label: 'Claude Fable 5', supportsEffort: false },
  { id: 'opus-4.8-200k', modelId: 'claude-opus-4-8', label: 'Claude Opus 4.8', context: '200k', supportsEffort: true },
  { id: 'opus-4.8-1m', modelId: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8', context: '1M', supportsEffort: true },
  { id: 'opus-4.7-200k', modelId: 'claude-opus-4-7', label: 'Claude Opus 4.7', context: '200k', supportsEffort: true },
  { id: 'opus-4.7-1m', modelId: 'claude-opus-4-7[1m]', label: 'Claude Opus 4.7', context: '1M', supportsEffort: true },
  { id: 'opus-4.6-200k', modelId: 'claude-opus-4-6', label: 'Claude Opus 4.6', context: '200k', supportsEffort: true },
  { id: 'opus-4.6-1m', modelId: 'claude-opus-4-6[1m]', label: 'Claude Opus 4.6', context: '1M', supportsEffort: true },
  { id: 'sonnet-4.6', modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', supportsEffort: false },
  { id: 'haiku-4.5', modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportsEffort: false },
];

export const DEFAULT_MODEL_ID = '';

export function getCliModelString(
  defaultModelId: string,
  customModels: CustomModel[],
): string | null {
  if (defaultModelId === '') return null;
  const builtin = BUILTIN_MODELS.find(m => m.id === defaultModelId);
  if (builtin) return builtin.modelId;
  const custom = customModels.find(m => m.id === defaultModelId);
  if (custom) return custom.modelId;
  if (defaultModelId.startsWith('claude-')) return defaultModelId;
  return 'claude-sonnet-4-6';
}

export function getModelDisplayLabel(
  modelId: string,
  customModels: CustomModel[],
): string {
  if (modelId === '') return 'Auto';
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId);
  if (builtin) {
    const name = builtin.label.replace('Claude ', '');
    return builtin.context ? `${name} (${builtin.context})` : name;
  }
  const custom = customModels.find(m => m.id === modelId);
  if (custom) return custom.label;
  if (modelId.startsWith('claude-')) return claudeAliasLabel(modelId).replace('Claude ', '');
  return modelId;
}

export type DetectedSuggestion = { modelId: string; label: string };

type Version = { family: string; major: number; minor: number };

const MAX_MINOR_VERSION = 100;

function parseVersion(modelId: string): Version | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(modelId);
  if (!m) return null;
  const minor = m[3] ? Number(m[3]) : 0;
  return { family: m[1], major: Number(m[2]), minor: minor < MAX_MINOR_VERSION ? minor : 0 };
}

function isNewer(a: Version, b: Version): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor);
}

function suggestionLabel(modelId: string, v: Version): string {
  const fam = v.family.charAt(0).toUpperCase() + v.family.slice(1);
  const ver = v.minor > 0 ? `${v.major}.${v.minor}` : `${v.major}`;
  const ctx = modelId.includes('[1m]') ? ' (1M)' : '';
  return `Claude ${fam} ${ver}${ctx}`;
}

export function claudeAliasLabel(modelId: string): string {
  const v = parseVersion(modelId);
  return v ? suggestionLabel(modelId, v) : modelId;
}

export function detectedClaudeModels(
  detected: DetectedModel[],
  customModels: CustomModel[],
): DetectedSuggestion[] {
  const known = new Set<string>([
    ...BUILTIN_MODELS.map(m => m.modelId),
    ...customModels.map(m => m.modelId),
  ]);

  const newest: Record<string, Version> = {};
  for (const m of BUILTIN_MODELS) {
    const v = parseVersion(m.modelId);
    if (!v) continue;
    if (!newest[v.family] || isNewer(v, newest[v.family])) newest[v.family] = v;
  }

  const out: DetectedSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of detected) {
    if (known.has(item.modelId) || seen.has(item.modelId)) continue;
    const v = parseVersion(item.modelId);
    if (!v) continue;
    const ref = newest[v.family];
    if (ref && !isNewer(v, ref)) continue;
    seen.add(item.modelId);
    out.push({ modelId: item.modelId, label: claudeAliasLabel(item.modelId) });
  }
  return out;
}

export const DEFAULT_TITLE_GEN_MODEL_ID = 'haiku';

export const FALLBACK_EFFORT_LEVELS: string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type ClaudeCustomModel = { modelId: string; label: string };

export type ClaudeModelSettings = {
  defaultModelId: string;
  titleGenModelId: string;
  modelEfforts: Record<string, string>;
  customModels: ClaudeCustomModel[];
};

export type LegacyClaudeModelSettings = {
  defaultModelId?: unknown;
  titleGenModelId?: unknown;
  modelEfforts?: unknown;
  customModels?: unknown;
};

const LEGACY_MODEL_IDS: Record<string, string> = {
  'fable-5': 'claude-fable-5',
  'opus-4.8-200k': 'claude-opus-4-8',
  'opus-4.8-1m': 'claude-opus-4-8[1m]',
  'opus-4.7-200k': 'claude-opus-4-7',
  'opus-4.7-1m': 'claude-opus-4-7[1m]',
  'opus-4.6-200k': 'claude-opus-4-6',
  'opus-4.6-1m': 'claude-opus-4-6[1m]',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'haiku-4.5': 'claude-haiku-4-5',
};

const LEGACY_CUSTOM_PREFIX = 'custom-';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrateCustomModels(raw: unknown): { models: ClaudeCustomModel[]; legacyIds: Map<string, string> } {
  const models: ClaudeCustomModel[] = [];
  const legacyIds = new Map<string, string>();
  if (!Array.isArray(raw)) return { models, legacyIds };
  for (const item of raw) {
    if (!isRecord(item) || typeof item.modelId !== 'string' || typeof item.label !== 'string') continue;
    const modelId = item.modelId.trim();
    if (!modelId || models.some(m => m.modelId === modelId)) continue;
    if (typeof item.id === 'string') legacyIds.set(item.id, modelId);
    models.push({ modelId, label: item.label });
  }
  return { models, legacyIds };
}

export function migrateClaudeModelSettings(raw: LegacyClaudeModelSettings): Partial<ClaudeModelSettings> {
  const { models, legacyIds } = migrateCustomModels(raw.customModels);
  const resolve = (id: string): string | null => {
    if (models.some(m => m.modelId === id)) return id;
    if (Object.prototype.hasOwnProperty.call(LEGACY_MODEL_IDS, id)) return LEGACY_MODEL_IDS[id];
    if (id.startsWith(LEGACY_CUSTOM_PREFIX)) return legacyIds.get(id) ?? null;
    return id;
  };

  const out: Partial<ClaudeModelSettings> = {};
  if (typeof raw.defaultModelId === 'string') {
    out.defaultModelId = resolve(raw.defaultModelId) ?? DEFAULT_MODEL_ID;
  }
  if (typeof raw.titleGenModelId === 'string') {
    out.titleGenModelId = resolve(raw.titleGenModelId) ?? DEFAULT_TITLE_GEN_MODEL_ID;
  }
  if (isRecord(raw.modelEfforts)) {
    const efforts: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.modelEfforts)) {
      const target = resolve(key);
      if (target === null || typeof value !== 'string' || !value) continue;
      efforts[target] = value;
    }
    out.modelEfforts = efforts;
  }
  if (raw.customModels !== undefined) out.customModels = models;
  return out;
}

export function claudeModelLabel(modelId: string, customModels: ClaudeCustomModel[]): string {
  if (modelId === '') return 'Auto';
  const custom = customModels.find(m => m.modelId === modelId);
  if (custom) return custom.label;
  if (modelId === DEFAULT_TITLE_GEN_MODEL_ID) return 'Haiku (najnowszy)';
  if (modelId.startsWith('claude-')) return claudeAliasLabel(modelId).replace(/^Claude /, '');
  return modelId;
}

export type ClaudeModelRow = { modelId: string; label: string };

export type ClaudeModelRows = {
  latest: ClaudeModelRow[];
  older: ClaudeModelRow[];
  custom: ClaudeModelRow[];
  undetected: ClaudeModelRow | null;
};

export function buildClaudeModelRows(
  detected: DetectedModel[],
  customModels: ClaudeCustomModel[],
  selectedId: string,
): ClaudeModelRows {
  const seen = new Set<string>();
  const latest: ClaudeModelRow[] = [];
  const older: ClaudeModelRow[] = [];
  for (const model of detected) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    const row = { modelId: model.modelId, label: claudeModelLabel(model.modelId, []) };
    (model.latest ? latest : older).push(row);
  }
  const custom = customModels.map(m => ({ modelId: m.modelId, label: m.label }));
  const known = selectedId === '' || seen.has(selectedId) || customModels.some(m => m.modelId === selectedId);
  return {
    latest,
    older,
    custom,
    undetected: known ? null : { modelId: selectedId, label: claudeModelLabel(selectedId, customModels) },
  };
}

export function effortOptions(levels: string[], current: string | undefined): string[] {
  return current && !levels.includes(current) ? [...levels, current] : levels;
}
