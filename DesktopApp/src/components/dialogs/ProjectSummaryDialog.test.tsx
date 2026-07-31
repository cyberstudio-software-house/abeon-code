import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectSummaryDialog } from './ProjectSummaryDialog';
import type { Project } from '../../types';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    projectUsage: vi.fn().mockResolvedValue({
      tokens: { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 },
      costUsd: 1.23,
      byModel: [{ model: 'claude-opus-4-8', tokens: { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 }, costUsd: 1.23 }],
      unknownModels: [],
      durationMs: null,
      activeMs: null,
    }),
    countSessions: vi.fn().mockResolvedValue(5),
  },
}));

const project = { id: 1, name: 'Demo', path: '/x', claudeDir: 'x', color: null } as unknown as Project;

describe('ProjectSummaryDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders session count, cost and per-model row', async () => {
    render(<ProjectSummaryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(await screen.findByText('claude-opus-4-8')).toBeInTheDocument();
    expect(await screen.findByText('~$1.23')).toBeInTheDocument();
  });
});
