import { useState } from 'react';
import { useStore } from '../../../store';
import { parseXtermTheme, TERMINAL_PALETTES, type TerminalColors } from '../../../lib/terminalAppearance';
import { BUTTON_CLASS, MONO_FIELD_CLASS, PRIMARY_BUTTON_CLASS, TEXTAREA_CLASS } from '../controls';

const FIELD_LABELS = [
  'Tło', 'Tekst',
  'Czarny', 'Czerwony', 'Zielony', 'Żółty', 'Niebieski', 'Magenta', 'Cyjan', 'Biały',
  'Jasny czarny', 'Jasny czerwony', 'Jasny zielony', 'Jasny żółty',
  'Jasny niebieski', 'Jasna magenta', 'Jasny cyjan', 'Jasny biały',
];

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const toFieldValues = (colors: TerminalColors) => [colors.background, colors.foreground, ...colors.ansi];

export function CustomPaletteEditor() {
  const customPalette = useStore(s => s.terminalCustomPalette);
  const setCustomPalette = useStore(s => s.setTerminalCustomPalette);
  const [values, setValues] = useState(() => toFieldValues(customPalette ?? TERMINAL_PALETTES.grafit.colors));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [rawTheme, setRawTheme] = useState('');
  const [themeError, setThemeError] = useState<string | null>(null);

  const save = () => {
    const invalid = values.findIndex(value => !HEX_COLOR.test(value.trim()));
    if (invalid !== -1) {
      setFieldError(`Nieprawidłowy kolor w polu „${FIELD_LABELS[invalid]}”`);
      return;
    }
    const [background, foreground, ...ansi] = values.map(value => value.trim());
    setFieldError(null);
    setCustomPalette({ background, foreground, ansi, ...(customPalette?.cursor ? { cursor: customPalette.cursor } : {}) });
  };

  const applyTheme = () => {
    const result = parseXtermTheme(rawTheme);
    if (!result.ok) {
      setThemeError(result.error);
      return;
    }
    setThemeError(null);
    setFieldError(null);
    setValues(toFieldValues(result.colors));
    setCustomPalette(result.colors);
  };

  return (
    <div className="flex flex-col gap-4 rounded-[10px] border border-border-strong bg-bg-elev p-3.5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-3 gap-y-2.5">
        {FIELD_LABELS.map((label, index) => {
          const id = `terminal-color-${index}`;
          return (
            <div key={id} className="flex flex-col gap-1">
              <label htmlFor={id} className="text-[11.5px] text-muted">{label}</label>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-6 w-6 shrink-0 rounded-[6px] border border-border-strong"
                  style={{ background: HEX_COLOR.test(values[index].trim()) ? values[index].trim() : 'transparent' }}
                />
                <input
                  id={id}
                  value={values[index]}
                  spellCheck={false}
                  onChange={e => setValues(current => current.map((value, i) => (i === index ? e.target.value : value)))}
                  className={`${MONO_FIELD_CLASS} w-full`}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} className={PRIMARY_BUTTON_CLASS}>Zapisz</button>
        {fieldError && <p role="alert" className="text-[12px] text-danger">{fieldError}</p>}
      </div>
      <div className="flex flex-col gap-2 border-t border-border-subtle pt-3.5">
        <label htmlFor="terminal-theme-json" className="text-[12.5px] font-medium text-fg">Wklej motyw xterm.js (JSON)</label>
        <textarea
          id="terminal-theme-json"
          rows={5}
          value={rawTheme}
          spellCheck={false}
          placeholder='{"background": "#101820", "red": "#ff5f5f"}'
          onChange={e => setRawTheme(e.target.value)}
          className={TEXTAREA_CLASS}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={applyTheme} disabled={rawTheme.trim() === ''} className={BUTTON_CLASS}>
            Zastosuj motyw
          </button>
          {themeError && <p role="alert" className="text-[12px] text-danger">{themeError}</p>}
        </div>
      </div>
    </div>
  );
}
