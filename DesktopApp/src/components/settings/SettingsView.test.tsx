import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { isTerminalCategorySeen } from '../../lib/settingsCategories';
import { SettingsView } from './SettingsView';

const OPTIONS = {
  models: [{ modelId: 'claude-opus-5-5', family: 'opus', source: 'binary', latest: true }],
  effortLevels: ['low', 'high'],
};

const nav = () => screen.getByRole('navigation', { name: 'Kategorie ustawień' });
const navItem = (name: RegExp) => within(nav()).getByRole('button', { name });

describe('SettingsView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(tauri, 'getGitUser').mockResolvedValue({ name: 'Ada Lovelace', initials: 'AL', email: 'ada@example.com' });
    vi.spyOn(tauri, 'listAvailableShells').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectDefaultShell').mockResolvedValue(null);
    vi.spyOn(tauri, 'listAvailableEditors').mockResolvedValue([]);
    vi.spyOn(tauri, 'attentionHookStatus').mockResolvedValue(false);
    vi.spyOn(tauri, 'detectClaudeOptions').mockResolvedValue(OPTIONS);
    useStore.setState({
      settingsOpen: true, settingsCategory: 'general', skipPermissions: false, displayName: '',
      enabledProviders: ['claude'], defaultModelId: '', modelEfforts: {}, customModels: [],
    });
  });

  it('lists the three groups and opens a category', async () => {
    render(<SettingsView />);
    for (const group of ['Aplikacja', 'Agenci', 'Integracje']) {
      expect(within(nav()).getByRole('heading', { name: group })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 1, name: 'Ogólne' })).toBeInTheDocument();

    fireEvent.click(navItem(/^Modele$/));

    expect(useStore.getState().settingsCategory).toBe('models');
    expect(navItem(/^Modele$/)).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('claude-opus-5-5')).toBeInTheDocument();
  });

  it('draws an icon on every navigation item', () => {
    render(<SettingsView />);
    const items = within(nav()).getAllByRole('button');
    expect(items).toHaveLength(11);
    for (const item of items) {
      expect(item.querySelector('svg')?.childElementCount ?? 0).toBeGreaterThan(0);
    }
  });

  it('filters the navigation from the search field', async () => {
    render(<SettingsView />);
    const search = screen.getByLabelText('Szukaj w ustawieniach');

    fireEvent.change(search, { target: { value: 'interlinia' } });

    const items = within(nav()).getAllByRole('button');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(/^Terminal/);
    expect(within(nav()).queryByRole('heading', { name: 'Agenci' })).toBeNull();
    expect(useStore.getState().settingsCategory).toBe('terminal');
    expect(screen.getByRole('heading', { level: 1, name: 'Terminal' })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });

    expect(within(nav()).getAllByRole('button')).toHaveLength(11);
    expect(useStore.getState().settingsCategory).toBe('terminal');
  });

  it('closes on Esc and on Wróć do sesji', () => {
    render(<SettingsView />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useStore.getState().settingsOpen).toBe(false);

    act(() => { useStore.setState({ settingsOpen: true }); });
    fireEvent.click(screen.getByRole('button', { name: /Wróć do sesji/ }));
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  it('ignores an Esc another handler already consumed', () => {
    render(<SettingsView />);
    const search = screen.getByLabelText('Szukaj w ustawieniach');
    search.addEventListener('keydown', event => event.preventDefault());

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(useStore.getState().settingsOpen).toBe(true);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useStore.getState().settingsOpen).toBe(true);
    dialog.remove();
  });

  it('shows bypass next to Uprawnienia while permissions are skipped', () => {
    render(<SettingsView />);
    expect(within(navItem(/Uprawnienia/)).queryByText('bypass')).toBeNull();

    act(() => { useStore.setState({ skipPermissions: true }); });

    expect(within(navItem(/Uprawnienia/)).getByText('bypass')).toBeInTheDocument();
  });

  it('shows Nowe on Terminal until the category is opened once', () => {
    render(<SettingsView />);
    expect(within(navItem(/Terminal/)).getByText('Nowe')).toBeInTheDocument();

    fireEvent.click(navItem(/Terminal/));

    expect(within(navItem(/Terminal/)).queryByText('Nowe')).toBeNull();
    expect(isTerminalCategorySeen()).toBe(true);

    cleanup();
    act(() => { useStore.setState({ settingsCategory: 'general' }); });
    render(<SettingsView />);
    expect(within(navItem(/Terminal/)).queryByText('Nowe')).toBeNull();
  });

  it('shows the profile footer without a settings button', async () => {
    render(<SettingsView />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ustawienia' })).toBeNull();
  });
});
