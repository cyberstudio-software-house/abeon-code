import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockState = Record<string, unknown>;
let mockState: MockState;

const gitMounted = vi.hoisted(() => vi.fn());

vi.mock('../../store', () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

vi.mock('./GitSection', async () => {
  const { useEffect } = await import('react');
  return {
    GitSection: () => {
      useEffect(() => { gitMounted(); }, []);
      return <div>git-stub</div>;
    },
  };
});
vi.mock('./ProjectToolbar', () => ({ ProjectToolbar: () => <div>toolbar-stub</div> }));
vi.mock('./ActionsSection', () => ({ ActionsSection: () => <div>actions-stub</div> }));
vi.mock('./ClickUpSection', () => ({ ClickUpSection: () => <div>clickup-stub</div> }));
vi.mock('./UsageSection', () => ({ UsageSection: () => <div>usage-stub</div> }));
vi.mock('../notes/NotesPanel', () => ({ NotesPanel: () => <div>notes-stub</div> }));
vi.mock('../files/FilesPanel', () => ({ FilesPanel: () => <div>files-stub</div> }));

import { RightPanel } from './RightPanel';

describe('RightPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState = { notesPanelOpen: false, filesPanelOpen: false };
  });

  it('keeps the sections mounted while notes are open', () => {
    const { rerender } = render(<RightPanel />);
    expect(screen.getByText('git-stub')).toBeVisible();
    expect(screen.queryByText('notes-stub')).not.toBeInTheDocument();
    expect(gitMounted).toHaveBeenCalledTimes(1);

    mockState = { notesPanelOpen: true, filesPanelOpen: false };
    rerender(<RightPanel />);
    expect(screen.getByText('notes-stub')).toBeInTheDocument();
    expect(screen.getByText('git-stub')).not.toBeVisible();
    expect(screen.getByText('toolbar-stub')).not.toBeVisible();
    expect(screen.getByText('git-stub').closest('[inert]')).not.toBeNull();

    mockState = { notesPanelOpen: false, filesPanelOpen: false };
    rerender(<RightPanel />);
    expect(screen.getByText('git-stub')).toBeVisible();
    expect(screen.queryByText('notes-stub')).not.toBeInTheDocument();
    expect(gitMounted).toHaveBeenCalledTimes(1);
  });

  it('shows the files panel instead of the sections while it is open', () => {
    const { rerender } = render(<RightPanel />);
    expect(screen.queryByText('files-stub')).not.toBeInTheDocument();

    mockState = { notesPanelOpen: false, filesPanelOpen: true };
    rerender(<RightPanel />);
    expect(screen.getByText('files-stub')).toBeInTheDocument();
    expect(screen.queryByText('notes-stub')).not.toBeInTheDocument();
    expect(screen.getByText('git-stub')).not.toBeVisible();
    expect(screen.getByText('toolbar-stub').closest('[inert]')).not.toBeNull();
    expect(gitMounted).toHaveBeenCalledTimes(1);

    mockState = { notesPanelOpen: false, filesPanelOpen: false };
    rerender(<RightPanel />);
    expect(screen.queryByText('files-stub')).not.toBeInTheDocument();
    expect(screen.getByText('git-stub')).toBeVisible();
  });
});
