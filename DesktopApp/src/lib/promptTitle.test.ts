import { describe, it, expect } from 'vitest';
import { promptTabTitle } from './promptTitle';

describe('promptTabTitle', () => {
  it('uses the first non-empty line', () => {
    expect(promptTabTitle('\n\n  Add endpoint  \nmore')).toBe('Add endpoint');
  });
  it('truncates to 40 chars with an ellipsis', () => {
    const line = 'a'.repeat(50);
    expect(promptTabTitle(line)).toBe(`${'a'.repeat(40)}…`);
  });
  it('keeps exactly 40 chars intact', () => {
    expect(promptTabTitle('b'.repeat(40))).toBe('b'.repeat(40));
  });
  it('falls back for blank prompts', () => {
    expect(promptTabTitle('  \n\t')).toBe('New session');
  });
});
