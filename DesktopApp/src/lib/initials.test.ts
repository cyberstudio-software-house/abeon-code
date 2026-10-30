import { describe, it, expect } from 'vitest';
import { initialsOf } from './initials';

describe('initialsOf', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Piotr Szweda')).toBe('PS');
    expect(initialsOf('  Jan  Maria Rokita ')).toBe('JM');
  });

  it('uppercases a single word down to one letter', () => {
    expect(initialsOf('piotr')).toBe('P');
  });

  it('returns an empty string for blank input', () => {
    expect(initialsOf('  ')).toBe('');
    expect(initialsOf('')).toBe('');
  });
});
