import { describe, it, expect } from 'vitest';
import {
  BUILTIN_MODELS,
  DEFAULT_MODEL_ID,
  getCliModelString,
  getModelDisplayLabel,
  detectedClaudeModels,
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

const d = (modelId: string, family: string): DetectedModel => ({ modelId, family, source: 'binary' });

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
