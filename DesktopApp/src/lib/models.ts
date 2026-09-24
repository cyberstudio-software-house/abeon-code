import type { DetectedModel } from '../types';

export const DEFAULT_MODEL_ID = '';

export function getCliModelString(modelId: string): string | null {
  return modelId === '' ? null : modelId;
}

type Version = { family: string; major: number; minor: number };

const MAX_MINOR_VERSION = 100;

function parseVersion(modelId: string): Version | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(modelId);
  if (!m) return null;
  const minor = m[3] ? Number(m[3]) : 0;
  return { family: m[1], major: Number(m[2]), minor: minor < MAX_MINOR_VERSION ? minor : 0 };
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

const LEGACY_TITLE_GEN_DEFAULT_ID = 'haiku-4.5';

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
    if (!modelId) continue;
    if (typeof item.id === 'string') legacyIds.set(item.id, modelId);
    if (models.some(m => m.modelId === modelId)) continue;
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
    out.titleGenModelId = raw.titleGenModelId === LEGACY_TITLE_GEN_DEFAULT_ID
      ? DEFAULT_TITLE_GEN_MODEL_ID
      : resolve(raw.titleGenModelId) ?? DEFAULT_TITLE_GEN_MODEL_ID;
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
