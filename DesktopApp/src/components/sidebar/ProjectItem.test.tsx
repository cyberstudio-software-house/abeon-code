import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('./SessionList', () => ({ SessionList: () => <div /> }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { makeView } from '../../test-helpers/deploy';
import { ProjectItem } from './ProjectItem';

const project = { id: 1, name: 'Alfa', path: '/a', color: null } as never;

describe('ProjectItem deployment status', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'countSessions').mockResolvedValue(3);
    useStore.setState({ trackings: [], expandedProjectIds: new Set<number>() });
  });

  it('shows no status without a tracking', () => {
    render(<ul><ProjectItem project={project} /></ul>);
    expect(screen.queryByRole('button', { name: /api:/ })).toBeNull();
  });

  it('shows a compact status and opens the details without toggling the row', () => {
    useStore.setState({ trackings: [makeView({ state: 'failed' }, [1])] });
    render(<ul><ProjectItem project={project} /></ul>);
    const chip = screen.getByRole('button', { name: 'api: Wdrożenie nie powiodło się' });
    expect(chip).not.toHaveTextContent('Wdrożenie');
    fireEvent.click(chip);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(useStore.getState().expandedProjectIds.has(1)).toBe(false);
  });
});
