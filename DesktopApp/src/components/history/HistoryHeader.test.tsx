import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SessionMeta } from '../../types';
import { HistoryHeader } from './HistoryHeader';

const meta: SessionMeta = {
  id: '1bccf2a7-aaaa-bbbb-cccc-000000000000',
  projectId: 1,
  title: 'Integracja Discord',
  messageCount: 128,
  lastModified: 0,
  createdAt: null,
  gitBranch: 'main',
  cwd: null,
  activity: 'idle',
  provider: 'claude',
  runningAgents: 0,
  totalAgents: 0,
};

function setup(overrides: Partial<SessionMeta> = {}) {
  return render(
    <HistoryHeader
      meta={{ ...meta, ...overrides }}
      viewMode="communication"
      onViewModeChange={vi.fn()}
      onToggleSearch={vi.fn()}
    />,
  );
}

describe('HistoryHeader', () => {
  it('shows the short activity label in a neutral pill', () => {
    const { container } = setup();
    const label = screen.getByText('Bezczynna');
    expect(label.className).toContain('bg-field');
    expect(label.querySelector('.bg-muted')).not.toBeNull();
    expect(container.querySelector('.bg-success')).toBeNull();
    expect(container.querySelector('.bg-accent')).toBeNull();
  });

  it('pulses the dot and drops the spinner while the session runs', () => {
    const { container } = setup({ activity: 'running' });
    expect(screen.getByText('Pracuje').querySelector('.activity-pulse')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('keeps the title editable', () => {
    setup();
    fireEvent.click(screen.getByRole('heading', { name: 'Integracja Discord' }));
    expect(screen.getByDisplayValue('Integracja Discord')).toBeTruthy();
  });

  it('shows the turn count, branch and provider in the meta row', () => {
    setup();
    expect(screen.getByText('128 tur')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
  });
});
