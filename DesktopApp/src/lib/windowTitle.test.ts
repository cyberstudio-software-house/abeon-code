import { describe, it, expect } from 'vitest';
import { formatWindowTitle, formatHeaderTitle } from './windowTitle';

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

  it('prefixes the project name before the title', () => {
    expect(formatWindowTitle('ABC', 'Project ABC')).toBe('Project ABC :: ABC — AbeonCode');
  });

  it('trims the project name', () => {
    expect(formatWindowTitle('ABC', '  Project ABC  ')).toBe('Project ABC :: ABC — AbeonCode');
  });

  it('omits the project prefix when the project name is empty or missing', () => {
    expect(formatWindowTitle('ABC', '')).toBe('ABC — AbeonCode');
    expect(formatWindowTitle('ABC', null)).toBe('ABC — AbeonCode');
  });

  it('truncates only the title portion, leaving the project name whole', () => {
    const long = 'a'.repeat(60);
    expect(formatWindowTitle(long, 'Proj')).toBe(`Proj :: ${'a'.repeat(40)}… — AbeonCode`);
  });

  it('ignores the project when there is no active tab', () => {
    expect(formatWindowTitle(null, 'Project ABC')).toBe('AbeonCode');
  });
});

describe('formatHeaderTitle', () => {
  it('shows just the app name when no tab is active', () => {
    expect(formatHeaderTitle(null)).toBe('AbeonCode');
    expect(formatHeaderTitle('   ')).toBe('AbeonCode');
  });

  it('shows the bare title when there is no project', () => {
    expect(formatHeaderTitle('ABC')).toBe('ABC');
  });

  it('prefixes the project name before the title, without the app-name suffix', () => {
    expect(formatHeaderTitle('ABC', 'Project ABC')).toBe('Project ABC :: ABC');
  });

  it('does not truncate the title (the header truncates via CSS)', () => {
    const long = 'a'.repeat(60);
    expect(formatHeaderTitle(long, 'Proj')).toBe(`Proj :: ${long}`);
  });
});
