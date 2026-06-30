import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpTaskDialog } from './ClickUpTaskDialog';

vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel({ activeAgentPtyId: 'pty-1', unlinkTask: vi.fn() }) }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    clickupGetTask: vi.fn().mockResolvedValue({ id: 't1', customId: 'CU-1', name: 'Fix', description: 'Body', status: 'open', url: 'u', attachments: [], comments: [] }),
    clickupWriteTaskFile: vi.fn().mockResolvedValue('.abeon/clickup/t1.md'),
    writeClipboardText: vi.fn().mockResolvedValue(undefined),
  },
}));
import { tauri } from '../../lib/tauri';

describe('ClickUpTaskDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('copies the handle after regenerating the file', async () => {
    render(<ClickUpTaskDialog projectId={1} taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Fix')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Kopiuj uchwyt'));
    await waitFor(() => expect(tauri.clickupWriteTaskFile).toHaveBeenCalledWith(1, 't1'));
    await waitFor(() => expect(tauri.writeClipboardText).toHaveBeenCalledWith('@.abeon/clickup/t1.md'));
  });
});
