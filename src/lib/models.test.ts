import { describe, it, expect } from 'vitest';
import { BUILTIN_MODELS, getCliModelString, getModelDisplayLabel } from './models';

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
