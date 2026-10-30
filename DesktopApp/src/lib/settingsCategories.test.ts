import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SETTINGS_CATEGORIES, SETTINGS_GROUPS, filterSettingsCategories, normalizeSearch,
  isTerminalCategorySeen, markTerminalCategorySeen, type SettingsCategoryId,
} from './settingsCategories';

const ALL: SettingsCategoryId[] = [
  'general', 'appearance', 'terminal', 'notifications', 'shortcuts', 'providers',
  'models', 'permissions', 'supervisor', 'cloud', 'clickup',
];

describe('settings groups and categories', () => {
  it('lists the groups in navigation order', () => {
    expect(SETTINGS_GROUPS).toEqual([
      { id: 'app', label: 'Aplikacja', categories: ['general', 'appearance', 'terminal', 'notifications', 'shortcuts'] },
      { id: 'agents', label: 'Agenci', categories: ['providers', 'models', 'permissions', 'supervisor'] },
      { id: 'integrations', label: 'Integracje', categories: ['cloud', 'clickup'] },
    ]);
  });

  it('declares labels and descriptions for every category', () => {
    expect(Object.keys(SETTINGS_CATEGORIES).sort()).toEqual([...ALL].sort());
    expect(SETTINGS_CATEGORIES.general.label).toBe('Ogólne');
    expect(SETTINGS_CATEGORIES.general.description).toBe('Profil, projekty, sesje i narzędzia systemowe.');
    expect(SETTINGS_CATEGORIES.terminal.description).toBe(
      'Wygląd konsoli w sesjach agentów, akcjach i terminalach shell. Zmiany widać od razu w podglądzie.',
    );
    expect(SETTINGS_CATEGORIES.shortcuts.label).toBe('Skróty klawiszowe');
    expect(SETTINGS_CATEGORIES.supervisor.label).toBe('Agent sterujący');
    for (const id of ALL) {
      expect(SETTINGS_CATEGORIES[id].description.length).toBeGreaterThan(0);
      expect(SETTINGS_CATEGORIES[id].keywords.length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeSearch', () => {
  it('lowercases and strips diacritics including l with stroke', () => {
    expect(normalizeSearch('Łódź ŻÓŁW')).toBe('lodz zolw');
  });
});

describe('filterSettingsCategories', () => {
  it('returns every category in group order for a blank query', () => {
    expect(filterSettingsCategories('')).toEqual(ALL);
    expect(filterSettingsCategories('   ')).toEqual(ALL);
  });

  it('matches row labels inside their category', () => {
    expect(filterSettingsCategories('interlinia')).toEqual(['terminal']);
    expect(filterSettingsCategories('skroty')).toEqual(['shortcuts']);
    expect(filterSettingsCategories('MOTYW')).toEqual(['appearance']);
    expect(filterSettingsCategories('domyślny shell')).toEqual(['general']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSettingsCategories('zzz')).toEqual([]);
  });

  it.each([
    ['Nazwa wyświetlana', 'general'],
    ['Ścieżka bazowa projektów', 'general'],
    ['Sesje po uruchomieniu', 'general'],
    ['Domyślny edytor', 'general'],
    ['Domyślny widok historii', 'general'],
    ['Pokaż aktywne sesje nad projektami', 'appearance'],
    ['Pomijaj pytania o uprawnienia', 'permissions'],
    ['Komenda terminala', 'providers'],
    ['Skill dla Claude Code', 'providers'],
    ['Wyzwalaj na', 'notifications'],
    ['Włącz zdalny most', 'cloud'],
    ['Token', 'clickup'],
    ['Karencja', 'supervisor'],
    ['Discord', 'supervisor'],
    ['Effort', 'models'],
  ] as const)('finds "%s" in %s', (query, id) => {
    expect(filterSettingsCategories(query)).toContain(id);
  });
});

describe('terminal category seen flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is false on a clean storage and true after marking', () => {
    localStorage.clear();
    expect(isTerminalCategorySeen()).toBe(false);
    markTerminalCategorySeen();
    expect(isTerminalCategorySeen()).toBe(true);
    expect(localStorage.getItem('abeoncode.settings.terminalSeen')).not.toBeNull();
  });

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(isTerminalCategorySeen()).toBe(false);
    expect(() => markTerminalCategorySeen()).not.toThrow();
  });
});
