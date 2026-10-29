import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SupervisorEntry } from './SupervisorEntry';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { toast } from 'sonner';
import type { SupervisorSnapshot } from '../../types';

const snapshot = (over: Partial<SupervisorSnapshot> = {}): SupervisorSnapshot => ({
  level: 'assistant', running: true, ready: true, ptyId: 'p1', present: true, away: false,
  escalations: [], approvals: [], cards: [], ...over,
});

const approval = (id: string) => ({
  id, sessionId: 's', projectId: 1, label: 'Sesja', action: 'git push', detail: 'git push origin main', code: 'ABC', createdAt: 1,
});
const escalation = (id: string) => ({
  id, sessionId: 's', projectId: 1, label: 'Sesja', summary: 'Pytanie', createdAt: 1,
});

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

describe('SupervisorEntry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'supervisorSetAway').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'onPtyOutput').mockResolvedValue(() => {});
    vi.spyOn(tauri, 'onPtyExit').mockResolvedValue(() => {});
    useStore.setState({ supervisor: snapshot(), supervisorPanelOpen: false });
  });

  it('shows the label and no badge at zero', () => {
    render(<SupervisorEntry />);
    expect(screen.getByText('Agent sterujący')).toBeInTheDocument();
    expect(screen.queryByTestId('supervisor-badge')).toBeNull();
  });

  it('sums approvals and escalations in the badge', () => {
    useStore.setState({
      supervisor: snapshot({ approvals: [approval('a1'), approval('a2')], escalations: [escalation('e1')] }),
    });
    render(<SupervisorEntry />);
    expect(screen.getByTestId('supervisor-badge')).toHaveTextContent('3');
  });

  it('calls supervisorSetAway(true) from the toggle without opening the panel', () => {
    render(<SupervisorEntry />);
    fireEvent.click(screen.getByRole('button', { name: 'Nie ma mnie' }));
    expect(tauri.supervisorSetAway).toHaveBeenCalledWith(true);
    expect(useStore.getState().supervisorPanelOpen).toBe(false);
  });

  it('shows a Polish toast when toggling away fails', async () => {
    vi.mocked(toast.error).mockClear();
    vi.spyOn(tauri, 'supervisorSetAway').mockRejectedValue(new Error('boom'));
    render(<SupervisorEntry />);
    fireEvent.click(screen.getByRole('button', { name: 'Nie ma mnie' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nie udało się zmienić statusu „Nie ma mnie”: boom'));
  });

  it('turns away off when it is already on', () => {
    useStore.setState({ supervisor: snapshot({ away: true }) });
    render(<SupervisorEntry />);
    const toggle = screen.getByRole('button', { name: 'Nie ma mnie' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(tauri.supervisorSetAway).toHaveBeenCalledWith(false);
  });

  it('opens the panel when the entry is clicked', () => {
    render(<SupervisorEntry />);
    fireEvent.click(screen.getByText('Agent sterujący'));
    expect(useStore.getState().supervisorPanelOpen).toBe(true);
  });

  it('shows the trust hint on the amber dot while starting', () => {
    useStore.setState({ supervisor: snapshot({ running: true, ready: false }) });
    render(<SupervisorEntry />);
    const dot = screen.getByTestId('supervisor-dot');
    expect(dot).toHaveAttribute('data-state', 'starting');
    expect(dot).toHaveAttribute(
      'title',
      'Uruchamianie… — otwórz panel i zaakceptuj zaufanie do folderu, jeśli pyta',
    );
  });

  it('marks the dot ready and stopped', () => {
    const { rerender } = render(<SupervisorEntry />);
    expect(screen.getByTestId('supervisor-dot')).toHaveAttribute('data-state', 'ready');
    useStore.setState({ supervisor: snapshot({ running: false, ready: false }) });
    rerender(<SupervisorEntry />);
    expect(screen.getByTestId('supervisor-dot')).toHaveAttribute('data-state', 'stopped');
  });
});
