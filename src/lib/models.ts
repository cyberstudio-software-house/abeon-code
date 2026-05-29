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
