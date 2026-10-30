import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpCategory } from './ClickUpCategory';

vi.mock('../../../lib/tauri', () => ({
  tauri: {
    clickupConnectionStatus: vi.fn().mockResolvedValue('absent'),
    clickupSetToken: vi.fn().mockResolvedValue(undefined),
    clickupClearToken: vi.fn().mockResolvedValue(undefined),
  },
}));
import { tauri } from '../../../lib/tauri';

describe('ClickUpCategory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the token via clickupSetToken', async () => {
    render(<ClickUpCategory />);
    await waitFor(() => expect(screen.getByText('Brak tokenu')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('pk_...'), { target: { value: 'pk_abc' } });
    fireEvent.click(screen.getByText('Zapisz token'));
    await waitFor(() => expect(tauri.clickupSetToken).toHaveBeenCalledWith('pk_abc'));
  });

  it('persists the typed token before checking status on test', async () => {
    render(<ClickUpCategory />);
    await waitFor(() => expect(screen.getByText('Brak tokenu')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('pk_...'), { target: { value: 'pk_new' } });
    fireEvent.click(screen.getByText('Testuj połączenie'));
    await waitFor(() => expect(tauri.clickupSetToken).toHaveBeenCalledWith('pk_new'));
    expect(tauri.clickupConnectionStatus).toHaveBeenCalled();
  });

  it('surfaces a connection error instead of failing silently', async () => {
    (tauri.clickupConnectionStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    render(<ClickUpCategory />);
    await waitFor(() => expect(screen.getByText(/offline/i)).toBeInTheDocument());
  });
});
