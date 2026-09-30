import { describe, it, expect } from 'vitest';
import { DRAWER_FOCUS_BINDINGS, FIXED_SHORTCUTS, SHORTCUTS, drawerFocusDirection, formatBinding } from './shortcuts';

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

describe('terminal drawer shortcuts', () => {
  it('registers configurable split shortcuts', () => {
    expect(SHORTCUTS.find(s => s.id === 'splitTerminalRight')?.defaultBinding).toBe('mod+shift+o');
    expect(SHORTCUTS.find(s => s.id === 'splitTerminalDown')?.defaultBinding).toBe('mod+shift+e');
  });

  it('lists split navigation as a fixed shortcut with an arrows badge', () => {
    const row = FIXED_SHORTCUTS.find(s => s.binding === 'mod+alt+arrows');
    expect(row).toBeDefined();
    expect(formatBinding('mod+alt+arrows')).toContain('←↑→↓');
  });

  it('maps mod+alt+arrow keys to directions', () => {
    const ev = (key: string) => new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true });
    expect(drawerFocusDirection(ev('ArrowLeft'))).toBe('left');
    expect(drawerFocusDirection(ev('ArrowDown'))).toBe('down');
    expect(drawerFocusDirection(new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true }))).toBeNull();
    expect(DRAWER_FOCUS_BINDINGS).toHaveLength(4);
  });
});
