import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import type { TerminalAppearance } from '../../lib/terminalAppearance';

export function useTerminalAppearance(): TerminalAppearance {
  return useStore(useShallow(s => ({
    fontId: s.terminalFontId,
    fontSize: s.terminalFontSize,
    lineHeight: s.terminalLineHeight,
    paletteId: s.terminalPaletteId,
    customPalette: s.terminalCustomPalette,
    cursorStyle: s.terminalCursorStyle,
    cursorBlink: s.terminalCursorBlink,
  })));
}
