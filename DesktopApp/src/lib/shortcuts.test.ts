import { describe, it, expect } from 'vitest';
import { FIXED_SHORTCUTS, formatBinding } from './shortcuts';

describe('mouse navigation shortcut', () => {
  it('exposes a fixed shortcut row for mouse back/forward', () => {
    const row = FIXED_SHORTCUTS.find(s => s.binding === 'mousenav');
    expect(row).toBeDefined();
    expect(row!.label).toBe('Nawigacja zakładek');
  });

  it('formats the mousenav token into a readable badge', () => {
    expect(formatBinding('mousenav')).toBe('Mysz ←/→');
  });
});
