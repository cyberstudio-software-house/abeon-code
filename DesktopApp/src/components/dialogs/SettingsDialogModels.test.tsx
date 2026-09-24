import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { SettingsDialog } from './SettingsDialog';

const OPTIONS = {
  models: [
    { modelId: 'claude-opus-5-5', family: 'opus', source: 'binary', latest: true },
    { modelId: 'claude-opus-5-5[1m]', family: 'opus', source: 'binary', latest: true },
    { modelId: 'claude-opus-4-8', family: 'opus', source: 'binary', latest: false },
  ],
  effortLevels: ['low', 'high', 'max'],
};

async function openModelsTab() {
  render(<SettingsDialog />);
  fireEvent.click(screen.getByText('Modele'));
  await screen.findByText('claude-opus-5-5');
}

describe('SettingsDialog Claude models', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'listAvailableShells').mockResolvedValue([]);
    vi.spyOn(tauri, 'detectDefaultShell').mockResolvedValue(null);
    vi.spyOn(tauri, 'listAvailableEditors').mockResolvedValue([]);
    vi.spyOn(tauri, 'attentionHookStatus').mockResolvedValue(false);
    vi.spyOn(tauri, 'detectClaudeOptions').mockResolvedValue(OPTIONS);
    useStore.setState({
      enabledProviders: ['claude'], defaultModelId: '', modelEfforts: {}, customModels: [],
    });
  });

  it('shows latest models and hides older ones until expanded', async () => {
    await openModelsTab();
    expect(screen.getByText('claude-opus-5-5[1m]')).toBeTruthy();
    expect(screen.queryByText('claude-opus-4-8')).toBeNull();
    fireEvent.click(screen.getByText('Pokaż starsze wersje (1)'));
    expect(screen.getByText('claude-opus-4-8')).toBeTruthy();
  });

  it('keeps the selected older model visible when collapsed', async () => {
    useStore.setState({ defaultModelId: 'claude-opus-4-8' });
    await openModelsTab();
    expect(screen.getByText('claude-opus-4-8')).toBeTruthy();
    expect(screen.queryByText('niewykryty')).toBeNull();
  });

  it('sets and clears effort per model, including Auto', async () => {
    await openModelsTab();
    fireEvent.change(screen.getByLabelText('Effort: Opus 5.5'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Effort: Auto (domyślny model Claude)'), { target: { value: 'max' } });
    expect(useStore.getState().modelEfforts).toEqual({ 'claude-opus-5-5': 'high', '': 'max' });
    fireEvent.change(screen.getByLabelText('Effort: Opus 5.5'), { target: { value: '' } });
    expect(useStore.getState().modelEfforts).toEqual({ '': 'max' });
  });

  it('selects a detected model', async () => {
    await openModelsTab();
    fireEvent.click(screen.getByText('Opus 5.5 (1M)'));
    expect(useStore.getState().defaultModelId).toBe('claude-opus-5-5[1m]');
  });

  it('marks a selected model that is no longer detected', async () => {
    useStore.setState({ defaultModelId: 'claude-opus-4-1' });
    await openModelsTab();
    expect(screen.getByText('niewykryty')).toBeTruthy();
  });

  it('shows a hint when nothing is detected', async () => {
    vi.spyOn(tauri, 'detectClaudeOptions').mockResolvedValue({ models: [], effortLevels: ['low'] });
    render(<SettingsDialog />);
    fireEvent.click(screen.getByText('Modele'));
    expect(await screen.findByText('Nie wykryto modeli — sprawdź instalację Claude Code')).toBeTruthy();
  });

  it('adds a custom model under Zaawansowane', async () => {
    await openModelsTab();
    fireEvent.click(screen.getByText('Zaawansowane'));
    fireEvent.click(screen.getByText('Dodaj własny model'));
    fireEvent.change(screen.getByPlaceholderText('np. My Fine-tuned Model'), { target: { value: 'Mine' } });
    fireEvent.change(screen.getByPlaceholderText('np. claude-sonnet-4-6'), { target: { value: 'us.anthropic.x' } });
    fireEvent.click(screen.getByText('Dodaj'));
    expect(useStore.getState().customModels).toEqual([{ modelId: 'us.anthropic.x', label: 'Mine' }]);
  });
});
