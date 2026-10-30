import type { ITheme } from '@xterm/xterm';

export type TerminalFontId = 'geistMono' | 'jetbrainsMono' | 'ibmPlexMono' | 'system';
export type TerminalLineHeight = 1.4 | 1.5 | 1.65;
export type TerminalPaletteId = 'grafit' | 'grafitHighContrast' | 'legacy' | 'custom';
export type TerminalCursorStyle = 'block' | 'bar' | 'underline';

export type TerminalColors = {
  background: string;
  foreground: string;
  cursor?: string;
  ansi: string[];
};

export const TERMINAL_FONTS: { id: TerminalFontId; label: string; css: string }[] = [
  { id: 'geistMono', label: 'Geist Mono', css: "'Geist Mono', ui-monospace, monospace" },
  { id: 'jetbrainsMono', label: 'JetBrains Mono', css: "'JetBrains Mono', ui-monospace, monospace" },
  { id: 'ibmPlexMono', label: 'IBM Plex Mono', css: "'IBM Plex Mono', ui-monospace, monospace" },
  { id: 'system', label: 'Systemowa monospace', css: 'ui-monospace, monospace' },
];

export const TERMINAL_LINE_HEIGHTS: TerminalLineHeight[] = [1.4, 1.5, 1.65];
export const TERMINAL_FONT_SIZE_RANGE = { min: 10, max: 20 } as const;

const CURSOR_STYLES: TerminalCursorStyle[] = ['block', 'bar', 'underline'];
const PALETTE_IDS: TerminalPaletteId[] = ['grafit', 'grafitHighContrast', 'legacy', 'custom'];

export const TERMINAL_PALETTES: Record<
  Exclude<TerminalPaletteId, 'custom'>,
  { label: string; note: string; colors: TerminalColors }
> = {
  grafit: {
    label: 'Grafit',
    note: 'Domyślna',
    colors: {
      background: '#0F1012',
      foreground: '#D7D9DD',
      ansi: [
        '#2A2C31', '#E5737A', '#7FCB9B', '#F0B44C', '#8FB3F9', '#C49BF2', '#5FD3B4', '#D7D9DD',
        '#4A4D53', '#FF8D93', '#9BE0B3', '#F6CB7D', '#ABC6FB', '#D7B7F7', '#86E3CB', '#F2F3F4',
      ],
    },
  },
  grafitHighContrast: {
    label: 'Grafit — wysoki kontrast',
    note: 'Jaśniejsze kolory na czarnym tle',
    colors: {
      background: '#000000',
      foreground: '#FFFFFF',
      ansi: [
        '#3A3D43', '#FF7B82', '#8EF0B0', '#FFD166', '#9CC2FF', '#D8B0FF', '#6EF2D4', '#FFFFFF',
        '#5A5E66', '#FF9AA0', '#A8F5C4', '#FFE08F', '#B8D4FF', '#E4C8FF', '#93F7E1', '#FFFFFF',
      ],
    },
  },
  legacy: {
    label: 'Obecna',
    note: 'Kolory sprzed zmiany wyglądu',
    colors: {
      background: '#1a1917',
      foreground: '#e8e6e1',
      ansi: [
        '#1a1917', '#c14a3d', '#61c454', '#f4be4f', '#5b9bd5', '#b78640', '#4db8a4', '#e8e6e1',
        '#6b6860', '#ec6a5e', '#7dd56f', '#f5cf6e', '#7db8e8', '#d4a04e', '#6dd4bf', '#faf8f5',
      ],
    },
  },
};

export const TERMINAL_DEFAULTS = {
  fontId: 'geistMono' as TerminalFontId,
  fontSize: 13,
  lineHeight: 1.65 as TerminalLineHeight,
  paletteId: 'grafit' as TerminalPaletteId,
  customPalette: null as TerminalColors | null,
  cursorStyle: 'block' as TerminalCursorStyle,
  cursorBlink: true,
};

const LIGHT_COLORS: TerminalColors = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#b78640',
  ansi: [
    '#1a1a1a', '#c14a3d', '#61c454', '#f4be4f', '#5b9bd5', '#b78640', '#4db8a4', '#52504a',
    '#94918a', '#ec6a5e', '#7dd56f', '#f5cf6e', '#7db8e8', '#d4a04e', '#6dd4bf', '#1a1a1a',
  ],
};

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const isColor = (value: unknown): value is string => typeof value === 'string' && COLOR_RE.test(value);

export const isTerminalFontId = (value: unknown): value is TerminalFontId =>
  TERMINAL_FONTS.some(font => font.id === value);

export const isTerminalLineHeight = (value: unknown): value is TerminalLineHeight =>
  TERMINAL_LINE_HEIGHTS.includes(value as TerminalLineHeight);

export const isTerminalPaletteId = (value: unknown): value is TerminalPaletteId =>
  PALETTE_IDS.includes(value as TerminalPaletteId);

export const isTerminalCursorStyle = (value: unknown): value is TerminalCursorStyle =>
  CURSOR_STYLES.includes(value as TerminalCursorStyle);

export const isTerminalColors = (value: unknown): value is TerminalColors => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const colors = value as Record<string, unknown>;
  return isColor(colors.background)
    && isColor(colors.foreground)
    && (colors.cursor === undefined || isColor(colors.cursor))
    && Array.isArray(colors.ansi)
    && colors.ansi.length === ANSI_KEYS.length
    && colors.ansi.every(isColor);
};

export const clampTerminalFontSize = (value: number) =>
  Math.max(TERMINAL_FONT_SIZE_RANGE.min, Math.min(TERMINAL_FONT_SIZE_RANGE.max, Math.round(value)));

export function buildTerminalTheme(
  paletteId: TerminalPaletteId,
  custom: TerminalColors | null,
  appTheme: 'dark' | 'light',
  accent: string,
): ITheme {
  const isDark = appTheme === 'dark';
  const colors = !isDark
    ? LIGHT_COLORS
    : paletteId === 'custom'
      ? custom ?? TERMINAL_PALETTES.grafit.colors
      : TERMINAL_PALETTES[paletteId].colors;
  const [
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  ] = colors.ansi;
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursor ?? accent,
    cursorAccent: colors.background,
    selectionBackground: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}

export function parseXtermTheme(
  raw: string,
): { ok: true; colors: TerminalColors } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Nieprawidłowy JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'To nie jest obiekt motywu xterm.js' };
  }
  const theme = parsed as Record<string, unknown>;
  const recognised = ['background', 'foreground', 'cursor', ...ANSI_KEYS];
  for (const key of recognised) {
    if (key in theme && !isColor(theme[key])) {
      return { ok: false, error: `Nieprawidłowy kolor w polu „${key}”` };
    }
  }
  const base = TERMINAL_PALETTES.grafit.colors;
  const colors: TerminalColors = {
    background: (theme.background as string | undefined) ?? base.background,
    foreground: (theme.foreground as string | undefined) ?? base.foreground,
    ansi: ANSI_KEYS.map((key, index) => (theme[key] as string | undefined) ?? base.ansi[index]),
  };
  if (typeof theme.cursor === 'string') colors.cursor = theme.cursor;
  return { ok: true, colors };
}
