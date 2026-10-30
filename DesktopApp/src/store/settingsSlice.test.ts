import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';
import { TERMINAL_DEFAULTS, TERMINAL_PALETTES } from '../lib/terminalAppearance';

describe('settingsSlice enabledProviders', () => {
  beforeEach(() => { useStore.setState({ enabledProviders: ['claude'] }); });

  it('toggleProvider adds and removes a provider', () => {
    useStore.getState().toggleProvider('codex');
    expect(useStore.getState().enabledProviders).toEqual(['claude', 'codex']);
    useStore.getState().toggleProvider('codex');
    expect(useStore.getState().enabledProviders).toEqual(['claude']);
  });

  it('never allows removing the last enabled provider', () => {
    useStore.getState().toggleProvider('claude');
    expect(useStore.getState().enabledProviders).toEqual(['claude']);
  });
});

describe('settingsSlice codex models', () => {
  beforeEach(() => {
    useStore.setState({ codexModelId: '', codexTitleGenModelId: '', codexCustomModels: [] });
  });

  it('addCodexCustomModel trims and dedupes', () => {
    useStore.getState().addCodexCustomModel('  gpt-5.5-codex  ');
    useStore.getState().addCodexCustomModel('gpt-5.5-codex');
    expect(useStore.getState().codexCustomModels).toEqual(['gpt-5.5-codex']);
  });

  it('addCodexCustomModel ignores empty input', () => {
    useStore.getState().addCodexCustomModel('   ');
    expect(useStore.getState().codexCustomModels).toEqual([]);
  });

  it('removeCodexCustomModel resets selections pointing at it', () => {
    useStore.getState().addCodexCustomModel('gpt-x');
    useStore.getState().setCodexModel('gpt-x');
    useStore.getState().setCodexTitleGenModel('gpt-x');
    useStore.getState().removeCodexCustomModel('gpt-x');
    expect(useStore.getState().codexCustomModels).toEqual([]);
    expect(useStore.getState().codexModelId).toBe('');
    expect(useStore.getState().codexTitleGenModelId).toBe('');
  });

  it('removeCodexCustomModel keeps selections of other models', () => {
    useStore.getState().addCodexCustomModel('gpt-a');
    useStore.getState().addCodexCustomModel('gpt-b');
    useStore.getState().setCodexModel('gpt-a');
    useStore.getState().removeCodexCustomModel('gpt-b');
    expect(useStore.getState().codexModelId).toBe('gpt-a');
  });
});

describe('settingsSlice OpenCode models', () => {
  beforeEach(() => {
    useStore.setState({ opencodeModelId: '', opencodeTitleGenModelId: '', opencodeCustomModels: [] });
  });

  it('trims and deduplicates custom models', () => {
    useStore.getState().addOpencodeCustomModel('  anthropic/claude-sonnet-4-5  ');
    useStore.getState().addOpencodeCustomModel('anthropic/claude-sonnet-4-5');
    expect(useStore.getState().opencodeCustomModels).toEqual(['anthropic/claude-sonnet-4-5']);
  });

  it('resets both selections when their custom model is removed', () => {
    useStore.getState().addOpencodeCustomModel('openai/gpt-5.4');
    useStore.getState().setOpencodeModel('openai/gpt-5.4');
    useStore.getState().setOpencodeTitleGenModel('openai/gpt-5.4');
    useStore.getState().removeOpencodeCustomModel('openai/gpt-5.4');
    expect(useStore.getState().opencodeModelId).toBe('');
    expect(useStore.getState().opencodeTitleGenModelId).toBe('');
  });

  it('persists all OpenCode model fields', () => {
    useStore.getState().addOpencodeCustomModel('openai/gpt-5.4');
    useStore.getState().setOpencodeModel('openai/gpt-5.4');
    useStore.getState().setOpencodeTitleGenModel('openai/gpt-5.4');
    const persisted = JSON.parse(localStorage.getItem('abeoncode.settings') ?? '{}');
    expect(persisted).toMatchObject({
      opencodeModelId: 'openai/gpt-5.4',
      opencodeTitleGenModelId: 'openai/gpt-5.4',
      opencodeCustomModels: ['openai/gpt-5.4'],
    });
  });
});

describe('settingsSlice showActiveSessions', () => {
  beforeEach(() => { useStore.setState({ showActiveSessions: true }); });

  it('defaults to true and toggles via setter', () => {
    expect(useStore.getState().showActiveSessions).toBe(true);
    useStore.getState().setShowActiveSessions(false);
    expect(useStore.getState().showActiveSessions).toBe(false);
  });
});

describe('settingsSlice claude models', () => {
  beforeEach(() => {
    useStore.setState({ defaultModelId: '', titleGenModelId: 'haiku', modelEfforts: {}, customModels: [] });
  });

  it('setModelEffort stores and clears a level, including for Auto', () => {
    useStore.getState().setModelEffort('', 'max');
    useStore.getState().setModelEffort('claude-opus-5-5', 'high');
    expect(useStore.getState().modelEfforts).toEqual({ '': 'max', 'claude-opus-5-5': 'high' });
    useStore.getState().setModelEffort('claude-opus-5-5', null);
    expect(useStore.getState().modelEfforts).toEqual({ '': 'max' });
  });

  it('addCustomModel trims and dedupes by modelId', () => {
    useStore.getState().addCustomModel({ modelId: '  claude-x-1 ', label: ' X ' });
    useStore.getState().addCustomModel({ modelId: 'claude-x-1', label: 'Other' });
    expect(useStore.getState().customModels).toEqual([{ modelId: 'claude-x-1', label: 'X' }]);
  });

  it('removeCustomModel resets selections and drops its effort', () => {
    useStore.getState().addCustomModel({ modelId: 'claude-x-1', label: 'X' });
    useStore.getState().setDefaultModel('claude-x-1');
    useStore.getState().setTitleGenModel('claude-x-1');
    useStore.getState().setModelEffort('claude-x-1', 'low');
    useStore.getState().removeCustomModel('claude-x-1');
    const s = useStore.getState();
    expect(s.customModels).toEqual([]);
    expect(s.defaultModelId).toBe('');
    expect(s.titleGenModelId).toBe('haiku');
    expect(s.modelEfforts).toEqual({});
  });
});

describe('settingsSlice terminal appearance', () => {
  beforeEach(() => { useStore.getState().resetTerminalAppearance(); });

  it('clamps the font size', () => {
    const { setTerminalFontSize } = useStore.getState();
    setTerminalFontSize(42);
    expect(useStore.getState().terminalFontSize).toBe(20);
    setTerminalFontSize(3);
    expect(useStore.getState().terminalFontSize).toBe(10);
    setTerminalFontSize(13.6);
    expect(useStore.getState().terminalFontSize).toBe(14);
    setTerminalFontSize(NaN);
    expect(useStore.getState().terminalFontSize).toBe(14);
  });

  it('setTerminalCustomPalette switches to the custom palette', () => {
    const colors = { ...TERMINAL_PALETTES.legacy.colors, background: '#101010' };
    useStore.getState().setTerminalCustomPalette(colors);
    const s = useStore.getState();
    expect(s.terminalCustomPalette).toEqual(colors);
    expect(s.terminalPaletteId).toBe('custom');
  });

  it('resetTerminalAppearance restores TERMINAL_DEFAULTS', () => {
    const s = useStore.getState();
    s.setTerminalFontId('system');
    s.setTerminalFontSize(18);
    s.setTerminalLineHeight(1.4);
    s.setTerminalCursorStyle('bar');
    s.setTerminalCursorBlink(false);
    s.setTerminalCustomPalette(TERMINAL_PALETTES.legacy.colors);
    useStore.getState().resetTerminalAppearance();
    const r = useStore.getState();
    expect({
      fontId: r.terminalFontId,
      fontSize: r.terminalFontSize,
      lineHeight: r.terminalLineHeight,
      paletteId: r.terminalPaletteId,
      customPalette: r.terminalCustomPalette,
      cursorStyle: r.terminalCursorStyle,
      cursorBlink: r.terminalCursorBlink,
    }).toEqual(TERMINAL_DEFAULTS);
  });

  it('persists the terminal appearance', () => {
    const s = useStore.getState();
    s.setTerminalFontId('jetbrainsMono');
    s.setTerminalFontSize(16);
    s.setTerminalLineHeight(1.5);
    s.setTerminalPaletteId('grafitHighContrast');
    s.setTerminalCursorStyle('underline');
    s.setTerminalCursorBlink(false);
    s.setTerminalCustomPalette(TERMINAL_PALETTES.legacy.colors);
    const persisted = JSON.parse(localStorage.getItem('abeoncode.settings') ?? '{}');
    expect(persisted).toMatchObject({
      terminalFontId: 'jetbrainsMono',
      terminalFontSize: 16,
      terminalLineHeight: 1.5,
      terminalPaletteId: 'custom',
      terminalCursorStyle: 'underline',
      terminalCursorBlink: false,
      terminalCustomPalette: TERMINAL_PALETTES.legacy.colors,
    });
  });
});

describe('settingsSlice settings category', () => {
  beforeEach(() => { useStore.setState({ settingsOpen: false, settingsCategory: 'general' }); });

  it('defaults to the general category', () => {
    expect(useStore.getState().settingsCategory).toBe('general');
  });

  it('openSettings with a category opens and switches to it', () => {
    useStore.getState().openSettings('clickup');
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useStore.getState().settingsCategory).toBe('clickup');
  });

  it('openSettings without a category keeps the current one', () => {
    useStore.getState().openSettings('clickup');
    useStore.getState().closeSettings();
    useStore.getState().openSettings();
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useStore.getState().settingsCategory).toBe('clickup');
  });

  it('setSettingsCategory switches the category', () => {
    useStore.getState().setSettingsCategory('models');
    expect(useStore.getState().settingsCategory).toBe('models');
  });
});
