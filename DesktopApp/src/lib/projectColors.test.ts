import { describe, it, expect } from 'vitest';
import { PROJECT_COLORS } from './projectColors';

describe('PROJECT_COLORS', () => {
  it('is a non-empty list of unique hex colors', () => {
    expect(PROJECT_COLORS.length).toBeGreaterThan(0);
    expect(new Set(PROJECT_COLORS).size).toBe(PROJECT_COLORS.length);
    for (const c of PROJECT_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});
