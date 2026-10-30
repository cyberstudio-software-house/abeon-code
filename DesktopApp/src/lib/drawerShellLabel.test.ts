import { describe, it, expect } from 'vitest';
import { drawerShellLabel } from './drawerShellLabel';

describe('drawerShellLabel', () => {
  it('uses the basename of a shell path', () => {
    expect(drawerShellLabel('/usr/bin/zsh')).toBe('zsh');
  });

  it('falls back to Terminal when the shell is on auto', () => {
    expect(drawerShellLabel('')).toBe('Terminal');
  });

  it('keeps a bare shell name', () => {
    expect(drawerShellLabel('fish')).toBe('fish');
  });

  it('handles windows separators', () => {
    expect(drawerShellLabel('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
  });
});
