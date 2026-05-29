import { describe, it, expect } from 'vitest';
import { BUILTIN_MODELS, getCliModelString, getModelDisplayLabel, detectUnknownModels } from './models';
import type { DetectedModel } from '../types/DetectedModel';

describe('Opus 4.8 builtin', () => {
  it('exposes 200k and 1M variants', () => {
    const ids = BUILTIN_MODELS.map(m => m.modelId);
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-8[1m]');
  });

  it('resolves the CLI string for the 1M variant', () => {
    expect(getCliModelString('opus-4.8-1m', [])).toBe('claude-opus-4-8[1m]');
  });

  it('formats the display label with context', () => {
    expect(getModelDisplayLabel('opus-4.8-200k', [])).toBe('Opus 4.8 (200k)');
    expect(getModelDisplayLabel('opus-4.8-1m', [])).toBe('Opus 4.8 (1M)');
  });

  it('marks 4.8 as effort-capable', () => {
    const m = BUILTIN_MODELS.find(x => x.id === 'opus-4.8-1m');
    expect(m?.supportsEffort).toBe(true);
  });
});

const d = (modelId: string, family: string): DetectedModel => ({ modelId, family, source: 'binary' });

describe('detectUnknownModels', () => {
  it('filters models already in the static list', () => {
    const out = detectUnknownModels([d('claude-opus-4-8', 'opus')], []);
    expect(out).toEqual([]);
  });

  it('filters models older than the newest known in their family', () => {
    const out = detectUnknownModels([d('claude-opus-4-5', 'opus')], []);
    expect(out).toEqual([]);
  });

  it('surfaces a newer opus with a 1M label', () => {
    const out = detectUnknownModels(
      [d('claude-opus-4-9', 'opus'), d('claude-opus-4-9[1m]', 'opus')],
      [],
    );
    expect(out).toEqual([
      { modelId: 'claude-opus-4-9', label: 'Claude Opus 4.9' },
      { modelId: 'claude-opus-4-9[1m]', label: 'Claude Opus 4.9 (1M)' },
    ]);
  });

  it('filters models already present as custom models', () => {
    const custom = [{ id: 'custom-1', modelId: 'claude-opus-4-9', label: 'x' }];
    const out = detectUnknownModels([d('claude-opus-4-9', 'opus')], custom);
    expect(out).toEqual([]);
  });
});
