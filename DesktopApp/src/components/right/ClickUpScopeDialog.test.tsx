import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadConfig = vi.fn().mockResolvedValue(undefined);
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel({ loadConfig }) }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    clickupListWorkspaces: vi.fn().mockResolvedValue([{ id: 'w1', name: 'Acme' }]),
    clickupListSpaces: vi.fn().mockResolvedValue([{ id: 's1', name: 'Space 1' }]),
    clickupListLists: vi.fn().mockResolvedValue([]),
    clickupGetConfig: vi.fn().mockResolvedValue({ projectId: 1, workspaceId: 'w1', spaceId: 's1', listId: null }),
    clickupSetConfig: vi.fn().mockResolvedValue(undefined),
  },
}));
import { tauri } from '../../lib/tauri';
import { ClickUpScopeDialog } from './ClickUpScopeDialog';

describe('ClickUpScopeDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prefills the selects from the saved config', async () => {
    render(<ClickUpScopeDialog projectId={1} onClose={() => {}} />);
    await waitFor(() => {
      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      expect(selects[0].value).toBe('w1');
      expect(selects[1].value).toBe('s1');
    });
  });

  it('refreshes the store config after saving', async () => {
    render(<ClickUpScopeDialog projectId={1} onClose={() => {}} />);
    await waitFor(() => expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('w1'));
    fireEvent.click(screen.getByText('Zapisz'));
    await waitFor(() => {
      expect(tauri.clickupSetConfig).toHaveBeenCalledWith(1, 'w1', 's1', null);
      expect(loadConfig).toHaveBeenCalledWith(1);
    });
  });
});
