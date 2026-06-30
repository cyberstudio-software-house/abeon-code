import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpTab } from './SettingsDialog';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    clickupConnectionStatus: vi.fn().mockResolvedValue('absent'),
    clickupSetToken: vi.fn().mockResolvedValue(undefined),
    clickupClearToken: vi.fn().mockResolvedValue(undefined),
  },
}));
import { tauri } from '../../lib/tauri';

describe('ClickUpTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the token via clickupSetToken', async () => {
    render(<ClickUpTab />);
    fireEvent.change(screen.getByPlaceholderText('pk_...'), { target: { value: 'pk_abc' } });
    fireEvent.click(screen.getByText('Zapisz token'));
    await waitFor(() => expect(tauri.clickupSetToken).toHaveBeenCalledWith('pk_abc'));
  });
});
