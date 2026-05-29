import { describe, it, expect } from 'vitest';
import { formatWindowTitle } from './windowTitle';

describe('formatWindowTitle', () => {
  it('shows just the app name when no tab is active', () => {
    expect(formatWindowTitle(null)).toBe('AbeonCode');
  });

  it('shows just the app name when the title is empty or whitespace', () => {
    expect(formatWindowTitle('')).toBe('AbeonCode');
    expect(formatWindowTitle('   ')).toBe('AbeonCode');
  });

  it('prefixes a short tab title before the app name', () => {
    expect(formatWindowTitle('ABC')).toBe('ABC — AbeonCode');
  });

  it('trims surrounding whitespace from the tab title', () => {
    expect(formatWindowTitle('  ABC  ')).toBe('ABC — AbeonCode');
  });

  it('keeps a title that is exactly at the 40-char limit intact', () => {
    const exact = 'a'.repeat(40);
    expect(formatWindowTitle(exact)).toBe(`${exact} — AbeonCode`);
  });

  it('truncates an over-limit title to 40 chars plus an ellipsis', () => {
    const long = 'a'.repeat(60);
    expect(formatWindowTitle(long)).toBe(`${'a'.repeat(40)}… — AbeonCode`);
  });
});
