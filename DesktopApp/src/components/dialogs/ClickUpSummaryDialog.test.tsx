import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpSummaryDialog } from './ClickUpSummaryDialog';

vi.mock('../../store', () => ({
  useStore: (sel: (s: unknown) => unknown) => sel({
    tabs: [{ kind: 'session', id: 'tab-1', projectId: 1, sessionId: 's1', title: 'S', mode: 'terminal', provider: 'claude' }],
    activeTabId: 'tab-1',
  }),
}));
vi.mock('../../lib/tauri', () => ({ tauri: {
  clickupGenerateSummary: vi.fn().mockResolvedValue('- zrobiono X'),
  clickupPostComment: vi.fn().mockResolvedValue(undefined),
}}));
import { tauri } from '../../lib/tauri';

describe('ClickUpSummaryDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('generates then posts the summary as a comment', async () => {
    render(<ClickUpSummaryDialog projectId={1} taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('zrobiono X'));
    fireEvent.click(screen.getByText('Wyślij jako komentarz'));
    await waitFor(() => expect(tauri.clickupPostComment).toHaveBeenCalledWith('t1', '- zrobiono X'));
  });
});
