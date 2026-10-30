import { useState } from 'react';
import { useStore } from '../../../store';
import { useShallow } from 'zustand/react/shallow';
import {
  TERMINAL_FONTS, TERMINAL_FONT_SIZE_RANGE, TERMINAL_LINE_HEIGHTS, TERMINAL_PALETTES,
  type TerminalCursorStyle, type TerminalLineHeight, type TerminalPaletteId,
} from '../../../lib/terminalAppearance';
import { SETTINGS_CATEGORIES, isTerminalCategorySeen } from '../../../lib/settingsCategories';
import { Icon } from '../../shared/Icon';
import {
  BUTTON_CLASS, Segmented, SelectField, SettingsPage, SettingsRow, SettingsSection, Stepper, Switch,
} from '../controls';
import { CustomPaletteEditor } from './CustomPaletteEditor';
import { TerminalPreview } from './TerminalPreview';

const LINE_HEIGHT_LABEL: Record<TerminalLineHeight, string> = { 1.4: '1,4', 1.5: '1,5', 1.65: '1,65' };

const LINE_HEIGHT_OPTIONS = TERMINAL_LINE_HEIGHTS.map(value => ({ value, label: LINE_HEIGHT_LABEL[value] }));

const CURSOR_OPTIONS: { value: TerminalCursorStyle; label: string; glyph: string }[] = [
  { value: 'block', label: 'Blok', glyph: 'h-[13px] w-[7px]' },
  { value: 'bar', label: 'Belka', glyph: 'h-[13px] w-0.5' },
  { value: 'underline', label: 'Podkreślenie', glyph: 'mt-2.5 h-0.5 w-2' },
];

const PRESET_PALETTE_IDS: Exclude<TerminalPaletteId, 'custom'>[] = ['grafit', 'grafitHighContrast', 'legacy'];

const CARD_BASE = 'rounded-[10px] border p-[10px_12px] text-left transition-colors';

function PaletteCard({ id, selected, onSelect }: {
  id: Exclude<TerminalPaletteId, 'custom'>;
  selected: boolean;
  onSelect: () => void;
}) {
  const palette = TERMINAL_PALETTES[id];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`${CARD_BASE} flex flex-col gap-2 bg-bg-elev ${selected ? 'border-accent' : 'border-border-raised hover:border-border-focus'}`}
    >
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 text-[12.5px] font-medium text-fg">{palette.label}</span>
        {selected && <Icon name="check" className="h-[13px] w-[13px] text-accent" strokeWidth={2.5} />}
      </span>
      <span
        aria-hidden
        className="flex gap-[3px] rounded-[6px] border border-border p-1.5"
        style={{ background: palette.colors.background }}
      >
        {palette.colors.ansi.slice(0, 8).map((color, index) => (
          <span key={index} className="h-3.5 flex-1 rounded-[3px]" style={{ background: color }} />
        ))}
      </span>
      <span className="text-[11.5px] text-muted">{palette.note}</span>
    </button>
  );
}

export function TerminalCategory() {
  const appearance = useStore(useShallow(s => ({
    fontId: s.terminalFontId,
    fontSize: s.terminalFontSize,
    lineHeight: s.terminalLineHeight,
    paletteId: s.terminalPaletteId,
    hasCustomPalette: s.terminalCustomPalette !== null,
    cursorStyle: s.terminalCursorStyle,
    cursorBlink: s.terminalCursorBlink,
  })));
  const setFontId = useStore(s => s.setTerminalFontId);
  const setFontSize = useStore(s => s.setTerminalFontSize);
  const setLineHeight = useStore(s => s.setTerminalLineHeight);
  const setPaletteId = useStore(s => s.setTerminalPaletteId);
  const setCursorStyle = useStore(s => s.setTerminalCursorStyle);
  const setCursorBlink = useStore(s => s.setTerminalCursorBlink);
  const resetAppearance = useStore(s => s.resetTerminalAppearance);
  const [isNew] = useState(() => !isTerminalCategorySeen());
  const [customOpen, setCustomOpen] = useState(appearance.paletteId === 'custom');
  const [editorRevision, setEditorRevision] = useState(0);

  const reset = () => {
    resetAppearance();
    setEditorRevision(revision => revision + 1);
  };

  const customSelected = appearance.paletteId === 'custom';

  const selectCustom = () => {
    if (appearance.hasCustomPalette) setPaletteId('custom');
    setCustomOpen(true);
  };

  return (
    <SettingsPage
      wide
      title={SETTINGS_CATEGORIES.terminal.label}
      description={SETTINGS_CATEGORIES.terminal.description}
      badge={isNew ? 'Nowe' : undefined}
      actions={<button type="button" onClick={reset} className={BUTTON_CLASS}>Przywróć domyślne</button>}
    >
      <div className="flex flex-wrap items-start gap-7">
        <div className="flex min-w-0 flex-[1_1_440px] flex-col gap-[22px]">
          <SettingsSection label="Czcionka">
            <SettingsRow
              label="Krój"
              htmlFor="terminal-font-family"
              description="Czcionka monospace dla wszystkich terminali."
            >
              <SelectField
                id="terminal-font-family"
                wrapperClassName="flex-[0_1_220px]"
                className="font-mono"
                value={appearance.fontId}
                onChange={e => setFontId(e.target.value as typeof appearance.fontId)}
              >
                {TERMINAL_FONTS.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
              </SelectField>
            </SettingsRow>
            <SettingsRow label="Rozmiar" labelId="terminal-font-size" description="W pikselach, od 10 do 20.">
              <Stepper
                value={appearance.fontSize}
                min={TERMINAL_FONT_SIZE_RANGE.min}
                max={TERMINAL_FONT_SIZE_RANGE.max}
                unit="px"
                onChange={setFontSize}
                labelledBy="terminal-font-size"
                decreaseLabel="Zmniejsz czcionkę"
                increaseLabel="Zwiększ czcionkę"
              />
            </SettingsRow>
            <SettingsRow
              label="Interlinia"
              labelId="terminal-line-height"
              description="Większa poprawia czytelność długich odpowiedzi agenta."
            >
              <Segmented
                value={appearance.lineHeight}
                options={LINE_HEIGHT_OPTIONS}
                onChange={setLineHeight}
                labelledBy="terminal-line-height"
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection label="Kolory">
            <div className="flex flex-col gap-3.5 px-[18px] pb-[18px] pt-3.5">
              <div>
                <span id="terminal-palette" data-settings-row-label="" className="block text-[13.5px] font-medium text-fg-strong">
                  Paleta ANSI
                </span>
                <p data-settings-row-description="" className="mt-[3px] text-[12px] leading-[1.5] text-muted">
                  16 kolorów terminala. Zmienia też kolory paska statusu Claude Code, jeśli Twój skrypt statusline używa kolorów ANSI.
                </p>
              </div>
              <div
                role="group"
                aria-labelledby="terminal-palette"
                className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2"
              >
                {PRESET_PALETTE_IDS.map(id => (
                  <PaletteCard
                    key={id}
                    id={id}
                    selected={appearance.paletteId === id}
                    onSelect={() => setPaletteId(id)}
                  />
                ))}
                <button
                  type="button"
                  aria-pressed={customSelected}
                  aria-expanded={customOpen}
                  onClick={selectCustom}
                  className={`${CARD_BASE} flex min-h-24 flex-col justify-center gap-1.5 border-dashed ${
                    customSelected ? 'border-accent' : 'border-rule hover:border-border-focus'
                  }`}
                >
                  <span className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
                    <Icon name={customSelected ? 'check' : 'plus'} className={`h-[13px] w-[13px] ${customSelected ? 'text-accent' : ''}`} strokeWidth={2.2} />
                    Własna
                  </span>
                  <span className="text-[11.5px] text-muted">Ustaw 16 kolorów ręcznie albo wklej motyw xterm.js (JSON).</span>
                </button>
              </div>
              {customOpen && <CustomPaletteEditor key={editorRevision} />}
            </div>
          </SettingsSection>

          <SettingsSection label="Kursor">
            <SettingsRow label="Kształt" labelId="terminal-cursor-shape">
              <Segmented
                value={appearance.cursorStyle}
                options={CURSOR_OPTIONS.map(option => ({
                  value: option.value,
                  label: (
                    <>
                      <span aria-hidden className={`bg-current ${option.glyph}`} />
                      {option.label}
                    </>
                  ),
                }))}
                onChange={setCursorStyle}
                labelledBy="terminal-cursor-shape"
              />
            </SettingsRow>
            <SettingsRow label="Miganie" labelId="terminal-cursor-blink">
              <Switch checked={appearance.cursorBlink} onChange={setCursorBlink} labelledBy="terminal-cursor-blink" />
            </SettingsRow>
          </SettingsSection>
        </div>

        <TerminalPreview />
      </div>
    </SettingsPage>
  );
}
