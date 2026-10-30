import { useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../../../store';
import {
  TERMINAL_FONTS, TERMINAL_PALETTES, type TerminalColors, type TerminalCursorStyle,
} from '../../../lib/terminalAppearance';
import { Segmented } from '../controls';

type PreviewKind = 'claude' | 'shell';

const PREVIEW_KINDS: { value: PreviewKind; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'shell', label: 'Shell' },
];

const PREVIEW_LABEL: Record<PreviewKind, string> = {
  claude: 'Przykładowa sesja Claude Code w wybranej palecie',
  shell: 'Przykładowy terminal shell w wybranej palecie',
};

const SWATCH_RING = 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)';

function Cursor({ style, blink, color }: { style: TerminalCursorStyle; blink: boolean; color: string }) {
  const shape: CSSProperties = style === 'bar'
    ? { width: '2px', height: '1.25em', verticalAlign: '-0.25em' }
    : style === 'underline'
      ? { width: '1ch', height: '2px', verticalAlign: '-0.25em' }
      : { width: '1ch', height: '1.25em', verticalAlign: '-0.25em' };
  return (
    <span
      data-preview-cursor={style}
      className={blink ? 'terminal-preview-blink' : undefined}
      style={{ display: 'inline-block', background: color, ...shape }}
    />
  );
}

function Line({ marker, markerColor, children }: { marker: ReactNode; markerColor?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '2ch minmax(0, 1fr)' }}>
      <span style={{ color: markerColor }}>{marker}</span>
      <span>{children}</span>
    </div>
  );
}

function ClaudeSample({ colors, cursor }: { colors: TerminalColors; cursor: ReactNode }) {
  const [, , green, yellow, blue, magenta, cyan, , dim] = colors.ansi;
  const rule = <div style={{ height: '1px', background: dim }} />;
  const divider = <span style={{ color: dim }}>│</span>;
  return (
    <>
      <Line marker="●">
        Uruchamiam testową sesję w <span style={{ color: blue }}>tmux</span> z flagą{' '}
        <span style={{ color: blue }}>--strict-mcp-config</span>.
      </Line>
      <Line marker="●" markerColor={green}>
        Bash(git status)
        <br />
        <span style={{ opacity: 0.6 }}>└  nothing to commit, working tree clean</span>
      </Line>
      <Line marker="✻" markerColor={yellow}>
        <span style={{ color: yellow }}>Hatching…</span>{' '}
        <span style={{ opacity: 0.6 }}>(50s · ↓ 4.1k tokens)</span>
      </Line>
      <div>
        {rule}
        <div style={{ padding: '5px 0' }}>❯ {cursor}</div>
        {rule}
        <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: '1ch', padding: '5px 0 0 2ch', fontSize: '0.92em' }}>
          <span style={{ opacity: 0.6 }}>~/…/AbeonCode</span>
          {divider}
          <span style={{ color: yellow }}>AbeonCode</span>
          {divider}
          <span style={{ color: blue }}>Opus 5.5</span>
          {divider}
          <span style={{ color: green }}>(main ✓)</span>
          {divider}
          <span style={{ color: cyan }}>ctx 14%</span>
        </div>
        <div style={{ paddingLeft: '2ch', fontSize: '0.92em', color: magenta }}>▸▸ bypass permissions on</div>
      </div>
    </>
  );
}

function ShellSample({ colors, cursor }: { colors: TerminalColors; cursor: ReactNode }) {
  const [, red, green, yellow, blue, magenta, cyan] = colors.ansi;
  const prompt = (
    <>
      <span style={{ color: green }}>piotr@abeon</span> <span style={{ color: blue }}>~/projects/AbeonCode</span>{' '}
      <span style={{ color: yellow }}>(main)</span>
    </>
  );
  return (
    <>
      <div>{prompt}</div>
      <div>$ git status --short</div>
      <div>
        <span style={{ color: yellow }}> M</span> src/store/settingsSlice.ts
        <br />
        <span style={{ color: red }}> D</span> src/lib/legacyTheme.ts
        <br />
        <span style={{ color: green }}>??</span> src/lib/terminalAppearance.ts
      </div>
      <div>$ ls</div>
      <div>
        <span style={{ color: blue }}>src</span>  <span style={{ color: blue }}>docs</span>{'  '}
        <span style={{ color: green }}>build.sh</span>  <span style={{ color: cyan }}>current</span>{'  '}
        <span style={{ color: magenta }}>logo.png</span>  package.json
      </div>
      <div>{prompt}</div>
      <div>$ {cursor}</div>
    </>
  );
}

export function TerminalPreview() {
  const fontId = useStore(s => s.terminalFontId);
  const fontSize = useStore(s => s.terminalFontSize);
  const lineHeight = useStore(s => s.terminalLineHeight);
  const paletteId = useStore(s => s.terminalPaletteId);
  const customPalette = useStore(s => s.terminalCustomPalette);
  const cursorStyle = useStore(s => s.terminalCursorStyle);
  const cursorBlink = useStore(s => s.terminalCursorBlink);
  const [kind, setKind] = useState<PreviewKind>('claude');

  const colors = paletteId === 'custom'
    ? customPalette ?? TERMINAL_PALETTES.grafit.colors
    : TERMINAL_PALETTES[paletteId].colors;
  const font = TERMINAL_FONTS.find(f => f.id === fontId) ?? TERMINAL_FONTS[0];
  const cursor = (
    <Cursor style={cursorStyle} blink={cursorBlink} color={colors.cursor ?? 'var(--color-accent)'} />
  );

  return (
    <aside aria-label="Podgląd terminala" className="flex min-w-0 max-w-[480px] flex-[1_1_380px] flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <h2 className="flex-1 text-[11px] font-medium uppercase tracking-[0.06em] text-label">Podgląd</h2>
        <span id="terminal-preview-kind" className="sr-only">Rodzaj podglądu</span>
        <Segmented value={kind} options={PREVIEW_KINDS} onChange={setKind} labelledBy="terminal-preview-kind" />
      </div>
      <div className="flex flex-col gap-3.5 rounded-[12px] border border-border bg-sunken p-3.5">
        <div
          role="img"
          aria-label={PREVIEW_LABEL[kind]}
          className="flex flex-col gap-3 overflow-hidden rounded-[9px] border border-border px-4 pb-3.5 pt-4"
          style={{
            background: colors.background,
            color: colors.foreground,
            fontFamily: font.css,
            fontSize: `${fontSize}px`,
            lineHeight,
          }}
        >
          {kind === 'claude'
            ? <ClaudeSample colors={colors} cursor={cursor} />
            : <ShellSample colors={colors} cursor={cursor} />}
        </div>
        <div className="flex flex-col gap-1.5">
          {[
            { range: '0–7', swatches: colors.ansi.slice(0, 8) },
            { range: '8–15', swatches: colors.ansi.slice(8, 16) },
          ].map(row => (
            <div key={row.range} className="flex items-center gap-2.5">
              <span className="w-10 font-mono text-[11px] text-muted">{row.range}</span>
              <span aria-hidden className="flex flex-1 gap-1">
                {row.swatches.map((color, index) => (
                  <span
                    key={index}
                    data-ansi-swatch=""
                    className="h-[18px] flex-1 rounded-[4px]"
                    style={{ background: color, boxShadow: SWATCH_RING }}
                  />
                ))}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[12px] text-muted">Zmiany obejmą też otwarte już terminale.</p>
      </div>
    </aside>
  );
}
