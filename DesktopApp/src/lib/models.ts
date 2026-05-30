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
  { id: 'opus-4.8-200k', modelId: 'claude-opus-4-8', label: 'Claude Opus 4.8', context: '200k', supportsEffort: true },
  { id: 'opus-4.8-1m', modelId: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8', context: '1M', supportsEffort: true },
  { id: 'opus-4.7-200k', modelId: 'claude-opus-4-7', label: 'Claude Opus 4.7', context: '200k', supportsEffort: true },
  { id: 'opus-4.7-1m', modelId: 'claude-opus-4-7[1m]', label: 'Claude Opus 4.7', context: '1M', supportsEffort: true },
  { id: 'opus-4.6-200k', modelId: 'claude-opus-4-6', label: 'Claude Opus 4.6', context: '200k', supportsEffort: true },
  { id: 'opus-4.6-1m', modelId: 'claude-opus-4-6[1m]', label: 'Claude Opus 4.6', context: '1M', supportsEffort: true },
  { id: 'sonnet-4.6', modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', supportsEffort: false },
  { id: 'haiku-4.5', modelId: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportsEffort: false },
];

export const DEFAULT_MODEL_ID = 'sonnet-4.6';

export function getCliModelString(
  defaultModelId: string,
  customModels: CustomModel[],
): string {
  const builtin = BUILTIN_MODELS.find(m => m.id === defaultModelId);
  if (builtin) return builtin.modelId;
  const custom = customModels.find(m => m.id === defaultModelId);
  if (custom) return custom.modelId;
  return 'claude-sonnet-4-6';
}

export function getModelDisplayLabel(
  modelId: string,
  customModels: CustomModel[],
): string {
  const builtin = BUILTIN_MODELS.find(m => m.id === modelId);
  if (builtin) {
    const name = builtin.label.replace('Claude ', '');
    return builtin.context ? `${name} (${builtin.context})` : name;
  }
  const custom = customModels.find(m => m.id === modelId);
  return custom?.label ?? modelId;
}

export type DetectedSuggestion = { modelId: string; label: string };

type Version = { family: string; major: number; minor: number };

function parseVersion(modelId: string): Version | null {
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(modelId);
  if (!m) return null;
  return { family: m[1], major: Number(m[2]), minor: Number(m[3]) };
}

function isNewer(a: Version, b: Version): boolean {
  return a.major > b.major || (a.major === b.major && a.minor > b.minor);
}

function suggestionLabel(modelId: string, v: Version): string {
  const fam = v.family.charAt(0).toUpperCase() + v.family.slice(1);
  const ctx = modelId.includes('[1m]') ? ' (1M)' : '';
  return `Claude ${fam} ${v.major}.${v.minor}${ctx}`;
}

export function detectUnknownModels(
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
    out.push({ modelId: item.modelId, label: suggestionLabel(item.modelId, v) });
  }
  return out;
}
