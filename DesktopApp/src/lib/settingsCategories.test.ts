import { createElement, type ComponentType } from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useStore } from '../store';
import { tauri } from './tauri';
import { GeneralCategory } from '../components/settings/categories/GeneralCategory';
import { AppearanceCategory } from '../components/settings/categories/AppearanceCategory';
import { TerminalCategory } from '../components/settings/categories/TerminalCategory';
import { NotificationsCategory } from '../components/settings/categories/NotificationsCategory';
import { ShortcutsCategory } from '../components/settings/categories/ShortcutsCategory';
import { ProvidersCategory } from '../components/settings/categories/ProvidersCategory';
import { ModelsCategory } from '../components/settings/categories/ModelsCategory';
import { PermissionsCategory } from '../components/settings/categories/PermissionsCategory';
import { SupervisorCategory } from '../components/settings/categories/SupervisorCategory';
import { CloudCategory } from '../components/settings/categories/CloudCategory';
import { ClickUpCategory } from '../components/settings/categories/ClickUpCategory';
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

  it('does not match strings that appear nowhere in the interface', () => {
    for (const query of ['Autonomiczny', 'Centrifugo', 'Urządzenia', 'Przypisanie']) {
      expect(filterSettingsCategories(query), query).toEqual([]);
    }
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
    ['Samodzielny', 'supervisor'],
    ['Adres CloudService', 'cloud'],
    ['Sparuj telefon', 'cloud'],
    ['Model do generowania tytułów', 'providers'],
    ['Powiadomienia systemowe, gdy sesja czeka na Ciebie', 'notifications'],
    ['odpowie kodem parowania', 'supervisor'],
    ['listę przy starcie', 'general'],
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

const PAGES: Record<SettingsCategoryId, ComponentType> = {
  general: GeneralCategory,
  appearance: AppearanceCategory,
  terminal: TerminalCategory,
  notifications: NotificationsCategory,
  shortcuts: ShortcutsCategory,
  providers: ProvidersCategory,
  models: ModelsCategory,
  permissions: PermissionsCategory,
  supervisor: SupervisorCategory,
  cloud: CloudCategory,
  clickup: ClickUpCategory,
};

describe('category keywords stay in sync with the rendered rows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'listAvailableShells').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectDefaultShell').mockResolvedValue(null);
    vi.spyOn(tauri, 'listAvailableEditors').mockResolvedValue([]);
    vi.spyOn(tauri, 'attentionHookStatus').mockResolvedValue(false);
    vi.spyOn(tauri, 'detectProviders').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectCodexModels').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectOpencodeModels').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectClaudeOptions').mockResolvedValue({ models: [], effortLevels: ['low', 'high'] });
    vi.spyOn(tauri, 'clickupConnectionStatus').mockResolvedValue('absent');
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue({
      bunPath: '/usr/bin/bun', tokenStored: true, bot: null, botError: null, pairedUsers: 0,
      pendingPairings: 0, policy: 'allowlist', chatLinked: false, globalPluginEnabled: false,
      channelActive: false, blocker: null,
    });
    useStore.setState({
      enabledProviders: ['claude', 'codex', 'opencode'],
      supervisorDiscordEnabled: true,
      shortcutOverrides: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  const collect = (root: ParentNode, attribute: string) =>
    Array.from(root.querySelectorAll(`[${attribute}]`))
      .map(node => (node.textContent ?? '').trim())
      .filter(text => text !== '');

  it.each(ALL)('finds every row label and description of %s in its own category', async id => {
    const { container } = render(createElement(PAGES[id]));
    await act(async () => {});

    const labels = collect(container, 'data-settings-row-label');
    const descriptions = collect(container, 'data-settings-row-description');

    expect(labels.length).toBeGreaterThan(0);
    for (const text of [...labels, ...descriptions]) {
      expect(filterSettingsCategories(text), text).toContain(id);
    }
  });
});
