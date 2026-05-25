import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitRepoGroup } from './GitRepoGroup';
import type { GitRepo } from '../../types';

const REPO: GitRepo = {
  label: 'frontend',
  branch: 'main',
  ahead: 1,
  behind: 0,
  files: [
    { path: 'src/App.tsx', status: 'M', staged: false, additions: 3, deletions: 1 },
    { path: 'src/util.ts', status: 'A', staged: true, additions: 10, deletions: 0 },
  ],
};

describe('GitRepoGroup', () => {
  it('renders header with label and file count when expanded', () => {
    render(<GitRepoGroup repo={REPO} collapsed={false} onToggle={() => {}} />);
    expect(screen.getByText('frontend')).toBeInTheDocument();
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
  });

  it('hides file list when collapsed', () => {
    render(<GitRepoGroup repo={REPO} collapsed={true} onToggle={() => {}} />);
    expect(screen.queryByText('src/App.tsx')).not.toBeInTheDocument();
  });

  it('calls onToggle when header clicked', () => {
    const onToggle = vi.fn();
    render(<GitRepoGroup repo={REPO} collapsed={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /frontend/i }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('forwards onSelectFile from row click', () => {
    const onSelectFile = vi.fn();
    render(<GitRepoGroup repo={REPO} collapsed={false} onToggle={() => {}} onSelectFile={onSelectFile} />);
    fireEvent.click(screen.getByText('src/App.tsx'));
    expect(onSelectFile).toHaveBeenCalledWith('src/App.tsx');
  });
});
