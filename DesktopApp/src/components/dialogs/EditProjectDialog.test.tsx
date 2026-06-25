import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Project } from '../../types';

const h = vi.hoisted(() => ({ state: {} as Record<string, unknown>, update: vi.fn() }));
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(h.state) }));

import { EditProjectDialog } from './EditProjectDialog';

const project: Project = {
  id: 3, name: 'gamma', path: '/p/3', claudeDir: '-p-3', color: null, sortOrder: 3, createdAt: 0,
};

describe('EditProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.update.mockResolvedValue(undefined);
    h.state = { updateProject: h.update };
  });

  it('pre-fills the name from the project', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    expect((screen.getByLabelText('Nazwa') as HTMLInputElement).value).toBe('gamma');
  });

  it('disables Zapisz when the name is empty', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: '  ' } });
    expect(screen.getByText('Zapisz')).toBeDisabled();
  });

  it('saves the trimmed name and selected color, then closes', async () => {
    const onClose = vi.fn();
    render(<EditProjectDialog project={project} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: '  gamma2  ' } });
    fireEvent.click(screen.getByLabelText('Kolor #b78640'));
    fireEvent.click(screen.getByText('Zapisz'));
    expect(h.update).toHaveBeenCalledWith(3, { name: 'gamma2', color: '#b78640' });
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('defaults to Auto for a project without a manual color', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    expect(screen.getByLabelText('Kolor automatyczny')).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends an empty color (auto) when no color is picked', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Zapisz'));
    expect(h.update).toHaveBeenCalledWith(3, { name: 'gamma', color: '' });
  });

  it('returns to auto when Auto is clicked after picking a color', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Kolor #b78640'));
    fireEvent.click(screen.getByLabelText('Kolor automatyczny'));
    fireEvent.click(screen.getByText('Zapisz'));
    expect(h.update).toHaveBeenCalledWith(3, { name: 'gamma', color: '' });
  });
});
