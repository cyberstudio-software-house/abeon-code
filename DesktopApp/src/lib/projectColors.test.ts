import { describe, it, expect } from 'vitest';
import { PROJECT_COLORS, getProjectColor } from './projectColors';

describe('PROJECT_COLORS', () => {
  it('is a list of unique hex colors', () => {
    expect(PROJECT_COLORS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(PROJECT_COLORS).size).toBe(PROJECT_COLORS.length);
    for (const c of PROJECT_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('getProjectColor', () => {
  it('returns the manually set color when present', () => {
    expect(getProjectColor({ id: 5, color: '#abcdef' })).toBe('#abcdef');
  });

  it('derives a deterministic color from the id when none is set', () => {
    expect(getProjectColor({ id: 0, color: null })).toBe(PROJECT_COLORS[0]);
    expect(getProjectColor({ id: 1, color: null })).toBe(PROJECT_COLORS[1]);
    expect(getProjectColor({ id: 1, color: null })).toBe(getProjectColor({ id: 1, color: null }));
  });

  it('wraps around the palette for ids beyond its length', () => {
    expect(getProjectColor({ id: PROJECT_COLORS.length, color: null })).toBe(PROJECT_COLORS[0]);
  });
});
