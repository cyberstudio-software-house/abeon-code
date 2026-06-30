import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkClickUpTaskDialog } from './LinkClickUpTaskDialog';

const linkTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel({ linkTask, linksByProject: { 1: [] } }) }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    clickupSearchTasks: vi
      .fn()
      .mockResolvedValue([{ id: 't9', customId: 'CU-9', name: 'Found', status: 'open', url: 'u', listName: null }]),
  },
}));

describe('LinkClickUpTaskDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('searches and links a task', async () => {
    render(<LinkClickUpTaskDialog projectId={1} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Szukaj po nazwie lub wklej ID/URL…'), { target: { value: 'Found' } });
    await waitFor(() => expect(screen.getByText('Found')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Found'));
    await waitFor(() => expect(linkTask).toHaveBeenCalledWith(1, 't9'));
  });
});
