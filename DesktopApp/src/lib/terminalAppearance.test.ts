import { describe, it, expect } from 'vitest';
import {
  buildTerminalTheme, parseXtermTheme, isTerminalColors, TERMINAL_PALETTES,
  type TerminalColors,
} from './terminalAppearance';

describe('buildTerminalTheme', () => {
  it('builds the Grafit theme by default', () => {
    const theme = buildTerminalTheme('grafit', null, 'dark', '#F0B44C');
    expect(theme.background).toBe('#0F1012');
    expect(theme.red).toBe('#E5737A');
    expect(theme.brightWhite).toBe('#F2F3F4');
    expect(theme.cursor).toBe('#F0B44C');
    expect(theme.cursorAccent).toBe('#0F1012');
    expect(theme.selectionBackground).toBe('rgba(255,255,255,0.15)');
  });

  it('falls back to Grafit for an empty custom palette', () => {
    const theme = buildTerminalTheme('custom', null, 'dark', '#F0B44C');
    expect(theme.background).toBe('#0F1012');
    expect(theme.foreground).toBe('#D7D9DD');
  });

  it('uses the custom palette and its own cursor when present', () => {
    const custom: TerminalColors = {
      ...TERMINAL_PALETTES.legacy.colors,
      background: '#101010',
      cursor: '#123456',
    };
    const theme = buildTerminalTheme('custom', custom, 'dark', '#F0B44C');
    expect(theme.background).toBe('#101010');
    expect(theme.cursor).toBe('#123456');
    expect(theme.green).toBe('#61c454');
  });

  it('keeps the light colors in the light theme', () => {
    for (const id of ['grafit', 'grafitHighContrast', 'legacy', 'custom'] as const) {
      const theme = buildTerminalTheme(id, null, 'light', '#F0B44C');
      expect(theme.background).toBe('#ffffff');
      expect(theme.white).toBe('#52504a');
      expect(theme.cursor).toBe('#b78640');
      expect(theme.selectionBackground).toBe('rgba(0,0,0,0.12)');
    }
  });
});

describe('parseXtermTheme', () => {
  it('parses a full xterm.js theme', () => {
    const theme = {
      background: '#101010', foreground: '#eee', cursor: '#ff0000',
      black: '#000000', red: '#111111', green: '#222222', yellow: '#333333',
      blue: '#444444', magenta: '#555555', cyan: '#666666', white: '#777777',
      brightBlack: '#888888', brightRed: '#999999', brightGreen: '#aaaaaa', brightYellow: '#bbbbbb',
      brightBlue: '#cccccc', brightMagenta: '#dddddd', brightCyan: '#eeeeee', brightWhite: '#ffffffff',
      selectionBackground: 'nonsense',
    };
    const result = parseXtermTheme(JSON.stringify(theme));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.colors.background).toBe('#101010');
    expect(result.colors.foreground).toBe('#eee');
    expect(result.colors.cursor).toBe('#ff0000');
    expect(result.colors.ansi).toHaveLength(16);
    expect(result.colors.ansi[0]).toBe('#000000');
    expect(result.colors.ansi[8]).toBe('#888888');
    expect(result.colors.ansi[15]).toBe('#ffffffff');
    expect(isTerminalColors(result.colors)).toBe(true);
  });

  it('fills missing keys from Grafit', () => {
    const result = parseXtermTheme('{"background":"#101010"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.colors.background).toBe('#101010');
    expect(result.colors.foreground).toBe('#D7D9DD');
    expect(result.colors.ansi[1]).toBe('#E5737A');
    expect(result.colors.cursor).toBeUndefined();
  });

  it('rejects malformed palette JSON', () => {
    expect(parseXtermTheme('{')).toEqual({ ok: false, error: 'Nieprawidłowy JSON' });
    expect(parseXtermTheme('[]')).toEqual({ ok: false, error: 'To nie jest obiekt motywu xterm.js' });
    expect(parseXtermTheme('null')).toEqual({ ok: false, error: 'To nie jest obiekt motywu xterm.js' });
    expect(parseXtermTheme('{"red":"blue"}')).toEqual({ ok: false, error: 'Nieprawidłowy kolor w polu „red”' });
    expect(parseXtermTheme('{"red":"#12"}')).toEqual({ ok: false, error: 'Nieprawidłowy kolor w polu „red”' });
    expect(parseXtermTheme('{"cursor":5}')).toEqual({ ok: false, error: 'Nieprawidłowy kolor w polu „cursor”' });
  });
});

describe('isTerminalColors', () => {
  it('rejects wrong shapes', () => {
    expect(isTerminalColors(null)).toBe(false);
    expect(isTerminalColors('x')).toBe(false);
    expect(isTerminalColors({ background: '#000', foreground: '#fff', ansi: ['#000'] })).toBe(false);
    expect(isTerminalColors(TERMINAL_PALETTES.grafit.colors)).toBe(true);
  });
});
