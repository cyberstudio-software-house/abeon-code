import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { useStore } from '../../../store';
import { TERMINAL_DEFAULTS, TERMINAL_PALETTES } from '../../../lib/terminalAppearance';
import { markTerminalCategorySeen } from '../../../lib/settingsCategories';
import { TerminalCategory } from './TerminalCategory';

const resetStore = () => {
  useStore.getState().resetTerminalAppearance();
};

describe('TerminalCategory', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it('renders the page with its sections and the new badge', () => {
    render(<TerminalCategory />);
    expect(screen.getByRole('heading', { level: 1, name: 'Terminal' })).toBeInTheDocument();
    expect(screen.getByText('Nowe')).toBeInTheDocument();
    for (const label of ['Czcionka', 'Kolory', 'Kursor']) {
      expect(screen.getByRole('heading', { level: 2, name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Przywróć domyślne' })).toBeInTheDocument();
  });

  it('hides the new badge once the category was seen', () => {
    markTerminalCategorySeen();
    render(<TerminalCategory />);
    expect(screen.queryByText('Nowe')).not.toBeInTheDocument();
  });

  it('changes the font size with the stepper and stops at 20', () => {
    useStore.setState({ terminalFontSize: 19 });
    render(<TerminalCategory />);

    const plus = screen.getByRole('button', { name: 'Zwiększ czcionkę' });
    fireEvent.click(plus);
    fireEvent.click(plus);

    expect(useStore.getState().terminalFontSize).toBe(20);
    expect(plus).toBeDisabled();
    expect(screen.getByText('20 px')).toBeInTheDocument();
  });

  it('changes the font family and the line height', () => {
    render(<TerminalCategory />);

    fireEvent.change(screen.getByLabelText('Krój'), { target: { value: 'jetbrainsMono' } });
    expect(useStore.getState().terminalFontId).toBe('jetbrainsMono');

    const lineHeight = screen.getByRole('group', { name: 'Interlinia' });
    expect(within(lineHeight).getByRole('button', { name: '1,65' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(lineHeight).getByRole('button', { name: '1,4' }));
    expect(useStore.getState().terminalLineHeight).toBe(1.4);
  });

  it('changes the cursor shape and blinking', () => {
    render(<TerminalCategory />);

    const shape = screen.getByRole('group', { name: 'Kształt' });
    fireEvent.click(within(shape).getByRole('button', { name: 'Belka' }));
    expect(useStore.getState().terminalCursorStyle).toBe('bar');

    fireEvent.click(screen.getByRole('switch', { name: 'Miganie' }));
    expect(useStore.getState().terminalCursorBlink).toBe(false);
  });

  it('selects a palette card', () => {
    render(<TerminalCategory />);

    const card = screen.getByRole('button', { name: /Grafit — wysoki kontrast/ });
    expect(card).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(card);

    expect(useStore.getState().terminalPaletteId).toBe('grafitHighContrast');
    expect(card).toHaveAttribute('aria-pressed', 'true');
  });

  it('rejects malformed palette JSON without touching the store', () => {
    render(<TerminalCategory />);

    fireEvent.click(screen.getByRole('button', { name: /Własna/ }));
    fireEvent.change(screen.getByLabelText('Wklej motyw xterm.js (JSON)'), { target: { value: '{"red":"blue"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zastosuj motyw' }));

    expect(screen.getByText('Nieprawidłowy kolor w polu „red”')).toBeInTheDocument();
    expect(useStore.getState().terminalCustomPalette).toBeNull();
    expect(useStore.getState().terminalPaletteId).toBe('grafit');
  });

  it('applies a pasted xterm.js theme', () => {
    render(<TerminalCategory />);

    fireEvent.click(screen.getByRole('button', { name: /Własna/ }));
    fireEvent.change(screen.getByLabelText('Wklej motyw xterm.js (JSON)'), {
      target: { value: '{"background":"#101820","red":"#ff0000"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Zastosuj motyw' }));

    const state = useStore.getState();
    expect(state.terminalPaletteId).toBe('custom');
    expect(state.terminalCustomPalette?.background).toBe('#101820');
    expect(state.terminalCustomPalette?.ansi[1]).toBe('#ff0000');
    expect(screen.getByLabelText('Tło')).toHaveValue('#101820');
  });

  it('saves colors typed into the sixteen-color editor', () => {
    render(<TerminalCategory />);

    fireEvent.click(screen.getByRole('button', { name: /Własna/ }));
    fireEvent.change(screen.getByLabelText('Czerwony'), { target: { value: '#abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));

    const state = useStore.getState();
    expect(state.terminalPaletteId).toBe('custom');
    expect(state.terminalCustomPalette?.ansi[1]).toBe('#abc');
    expect(state.terminalCustomPalette?.ansi[2]).toBe(TERMINAL_PALETTES.grafit.colors.ansi[2]);
  });

  it('refuses to save a malformed typed color', () => {
    render(<TerminalCategory />);

    fireEvent.click(screen.getByRole('button', { name: /Własna/ }));
    fireEvent.change(screen.getByLabelText('Zielony'), { target: { value: 'green' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));

    expect(screen.getByText('Nieprawidłowy kolor w polu „Zielony”')).toBeInTheDocument();
    expect(useStore.getState().terminalCustomPalette).toBeNull();
    expect(useStore.getState().terminalPaletteId).toBe('grafit');
  });

  it('restores the defaults', () => {
    render(<TerminalCategory />);

    fireEvent.click(screen.getByRole('button', { name: 'Zwiększ czcionkę' }));
    fireEvent.click(screen.getByRole('button', { name: /Grafit — wysoki kontrast/ }));
    fireEvent.click(screen.getByRole('switch', { name: 'Miganie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Przywróć domyślne' }));

    const s = useStore.getState();
    expect({
      fontId: s.terminalFontId,
      fontSize: s.terminalFontSize,
      lineHeight: s.terminalLineHeight,
      paletteId: s.terminalPaletteId,
      customPalette: s.terminalCustomPalette,
      cursorStyle: s.terminalCursorStyle,
      cursorBlink: s.terminalCursorBlink,
    }).toEqual(TERMINAL_DEFAULTS);
  });

  it('renders sixteen swatches of the chosen palette', () => {
    const { container } = render(<TerminalCategory />);

    const swatches = container.querySelectorAll<HTMLElement>('[data-ansi-swatch]');
    expect(swatches).toHaveLength(16);
    expect(swatches[0]).toHaveStyle({ background: '#2A2C31' });

    fireEvent.click(screen.getByRole('button', { name: /Grafit — wysoki kontrast/ }));
    expect(container.querySelectorAll<HTMLElement>('[data-ansi-swatch]')[0]).toHaveStyle({ background: '#3A3D43' });
  });

  it('renders the preview in the chosen font, size and line height and switches to the shell sample', () => {
    useStore.setState({ terminalFontSize: 16, terminalLineHeight: 1.5, terminalFontId: 'ibmPlexMono' });
    render(<TerminalCategory />);

    const sample = screen.getByRole('img', { name: 'Przykładowa sesja Claude Code w wybranej palecie' });
    expect(sample).toHaveStyle({ fontSize: '16px', lineHeight: '1.5' });
    expect(sample.style.fontFamily).toContain('IBM Plex Mono');
    expect(screen.getByText('Zmiany obejmą też otwarte już terminale.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Shell' }));
    expect(screen.getByRole('img', { name: 'Przykładowy terminal shell w wybranej palecie' })).toBeInTheDocument();
  });
});
