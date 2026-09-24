import { describe, it, expect } from 'vitest';
import {
  BUILTIN_MODELS,
  DEFAULT_MODEL_ID,
  getCliModelString,
  getModelDisplayLabel,
  detectedClaudeModels,
  migrateClaudeModelSettings,
  claudeModelLabel,
  buildClaudeModelRows,
  effortOptions,
  DEFAULT_TITLE_GEN_MODEL_ID,
  FALLBACK_EFFORT_LEVELS,
} from './models';
import type { DetectedModel } from '../types';

describe('builtin list', () => {
  it('exposes Opus 4.8 200k and 1M variants', () => {
    const ids = BUILTIN_MODELS.map(m => m.modelId);
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-8[1m]');
  });

  it('includes Fable 5', () => {
    expect(BUILTIN_MODELS.map(m => m.modelId)).toContain('claude-fable-5');
  });

  it('defaults to Auto', () => {
    expect(DEFAULT_MODEL_ID).toBe('');
  });
});

describe('getCliModelString', () => {
  it('returns null for Auto', () => {
    expect(getCliModelString('', [])).toBeNull();
  });

  it('resolves a builtin id to its CLI alias', () => {
    expect(getCliModelString('opus-4.8-1m', [])).toBe('claude-opus-4-8[1m]');
  });

  it('passes a raw detected alias through', () => {
    expect(getCliModelString('claude-opus-4-9', [])).toBe('claude-opus-4-9');
  });

  it('falls back to sonnet for an unknown non-alias id', () => {
    expect(getCliModelString('garbage', [])).toBe('claude-sonnet-4-6');
  });
});

describe('getModelDisplayLabel', () => {
  it('labels Auto', () => {
    expect(getModelDisplayLabel('', [])).toBe('Auto');
  });

  it('formats a builtin label with context', () => {
    expect(getModelDisplayLabel('opus-4.8-200k', [])).toBe('Opus 4.8 (200k)');
    expect(getModelDisplayLabel('opus-4.8-1m', [])).toBe('Opus 4.8 (1M)');
  });

  it('labels a raw detected alias', () => {
    expect(getModelDisplayLabel('claude-fable-5', [])).toBe('Fable 5');
  });
});

const d = (modelId: string, family: string): DetectedModel => ({ modelId, family, source: 'binary', latest: false });

describe('detectedClaudeModels', () => {
  it('drops models already in the static list', () => {
    expect(detectedClaudeModels([d('claude-opus-4-8', 'opus')], [])).toEqual([]);
  });

  it('drops models older than the newest known in their family', () => {
    expect(detectedClaudeModels([d('claude-opus-4-5', 'opus')], [])).toEqual([]);
  });

  it('surfaces a newer opus with a 1M label', () => {
    const out = detectedClaudeModels(
      [d('claude-opus-4-9', 'opus'), d('claude-opus-4-9[1m]', 'opus')],
      [],
    );
    expect(out).toEqual([
      { modelId: 'claude-opus-4-9', label: 'Claude Opus 4.9' },
      { modelId: 'claude-opus-4-9[1m]', label: 'Claude Opus 4.9 (1M)' },
    ]);
  });

  it('surfaces an unknown family (single-major) as a suggestion', () => {
    expect(detectedClaudeModels([d('claude-newfamily-7', 'newfamily')], [])).toEqual([
      { modelId: 'claude-newfamily-7', label: 'Claude Newfamily 7' },
    ]);
  });

  it('drops models already present as custom models', () => {
    const custom = [{ id: 'custom-1', modelId: 'claude-opus-4-9', label: 'x' }];
    expect(detectedClaudeModels([d('claude-opus-4-9', 'opus')], custom)).toEqual([]);
  });
});

const dm = (modelId: string, latest: boolean): DetectedModel => ({
  modelId, family: 'opus', source: 'binary', latest,
});

describe('migrateClaudeModelSettings', () => {
  it('maps legacy builtin ids to raw CLI strings', () => {
    expect(migrateClaudeModelSettings({ defaultModelId: 'opus-4.8-1m', titleGenModelId: 'haiku-4.5' }))
      .toEqual({ defaultModelId: 'claude-opus-4-8[1m]', titleGenModelId: 'claude-haiku-4-5' });
  });

  it('maps legacy custom ids to their modelId and drops the synthetic id', () => {
    const out = migrateClaudeModelSettings({
      defaultModelId: 'custom-ab12',
      customModels: [{ id: 'custom-ab12', modelId: 'claude-x-1', label: 'X' }],
    });
    expect(out.defaultModelId).toBe('claude-x-1');
    expect(out.customModels).toEqual([{ modelId: 'claude-x-1', label: 'X' }]);
  });

  it('resets an unknown custom id to the defaults', () => {
    expect(migrateClaudeModelSettings({ defaultModelId: 'custom-gone', titleGenModelId: 'custom-gone' }))
      .toEqual({ defaultModelId: '', titleGenModelId: DEFAULT_TITLE_GEN_MODEL_ID });
  });

  it('keeps a migrated custom model whose id starts with custom-', () => {
    const out = migrateClaudeModelSettings({
      defaultModelId: 'custom-model',
      customModels: [{ modelId: 'custom-model', label: 'Mine' }],
    });
    expect(out.defaultModelId).toBe('custom-model');
  });

  it('remaps effort keys and drops efforts of unknown custom models', () => {
    const out = migrateClaudeModelSettings({
      modelEfforts: { 'opus-4.7-200k': 'high', 'custom-gone': 'low', 'claude-opus-5-5': 'max', '': 'medium' },
    });
    expect(out.modelEfforts).toEqual({ 'claude-opus-4-7': 'high', 'claude-opus-5-5': 'max', '': 'medium' });
  });

  it('ignores malformed input', () => {
    expect(migrateClaudeModelSettings({
      defaultModelId: 5, modelEfforts: ['x'], customModels: [{ modelId: 3 }, 'x', null],
    })).toEqual({ customModels: [] });
  });

  it('is idempotent', () => {
    const once = migrateClaudeModelSettings({
      defaultModelId: 'opus-4.8-1m',
      titleGenModelId: 'custom-a',
      modelEfforts: { 'opus-4.8-1m': 'high' },
      customModels: [{ id: 'custom-a', modelId: 'claude-z-2', label: 'Z' }],
    });
    expect(migrateClaudeModelSettings(once)).toEqual(once);
  });
});

describe('claudeModelLabel', () => {
  it('labels Auto, aliases, custom models and the haiku alias', () => {
    expect(claudeModelLabel('', [])).toBe('Auto');
    expect(claudeModelLabel('claude-opus-5-5[1m]', [])).toBe('Opus 5.5 (1M)');
    expect(claudeModelLabel('claude-sonnet-5', [])).toBe('Sonnet 5');
    expect(claudeModelLabel('claude-x-1', [{ modelId: 'claude-x-1', label: 'Mine' }])).toBe('Mine');
    expect(claudeModelLabel(DEFAULT_TITLE_GEN_MODEL_ID, [])).toBe('Haiku (najnowszy)');
    expect(claudeModelLabel('something', [])).toBe('something');
  });

  it('treats a date-like minor as no minor', () => {
    expect(claudeModelLabel('claude-opus-4-20250514', [])).toBe('Opus 4');
  });
});

describe('buildClaudeModelRows', () => {
  const detected = [dm('claude-opus-5-5', true), dm('claude-opus-5-5[1m]', true), dm('claude-opus-4-8', false)];

  it('splits latest and older rows with labels', () => {
    const rows = buildClaudeModelRows(detected, [], '');
    expect(rows.latest).toEqual([
      { modelId: 'claude-opus-5-5', label: 'Opus 5.5' },
      { modelId: 'claude-opus-5-5[1m]', label: 'Opus 5.5 (1M)' },
    ]);
    expect(rows.older).toEqual([{ modelId: 'claude-opus-4-8', label: 'Opus 4.8' }]);
    expect(rows.undetected).toBeNull();
  });

  it('lists custom models and does not mark them undetected', () => {
    const rows = buildClaudeModelRows(detected, [{ modelId: 'claude-x-1', label: 'X' }], 'claude-x-1');
    expect(rows.custom).toEqual([{ modelId: 'claude-x-1', label: 'X' }]);
    expect(rows.undetected).toBeNull();
  });

  it('marks a selected model that is neither detected nor custom', () => {
    expect(buildClaudeModelRows(detected, [], 'claude-opus-4-1').undetected)
      .toEqual({ modelId: 'claude-opus-4-1', label: 'Opus 4.1' });
  });

  it('dedupes repeated detected ids', () => {
    expect(buildClaudeModelRows([dm('claude-opus-5-5', true), dm('claude-opus-5-5', true)], [], '').latest)
      .toHaveLength(1);
  });
});

describe('effortOptions', () => {
  it('returns detected levels', () => {
    expect(effortOptions(FALLBACK_EFFORT_LEVELS, 'high')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('effortOptions keeps an unknown current level', () => {
    expect(effortOptions(['low', 'high'], 'ultra')).toEqual(['low', 'high', 'ultra']);
  });
});
