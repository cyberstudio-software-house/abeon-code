import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SupervisorPanel } from './SupervisorPanel';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { toast } from 'sonner';
import type { DecisionEntry, SupervisorSnapshot } from '../../types';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

vi.mock('../terminal/TerminalView', () => ({
  TerminalView: (props: { kind: string; ptyId?: string }) => (
    <div data-testid="terminal" data-kind={props.kind} data-pty={props.ptyId} />
  ),
}));

const snapshot = (over: Partial<SupervisorSnapshot> = {}): SupervisorSnapshot => ({
  level: 'assistant', running: true, ready: true, ptyId: 'p1', present: true, away: false, discordActive: false,
  escalations: [], approvals: [], cards: [], ...over,
});

const decisions: DecisionEntry[] = [
  { id: 2, createdAt: 2000, sessionId: 's1', kind: 'answered', question: 'Który plik zmienić?', decision: 'src/a.ts', rationale: 'r' },
  { id: 1, createdAt: 1000, sessionId: null, kind: 'guard_blocked', question: 'git push origin main', decision: 'zablokowano', rationale: '' },
];

describe('SupervisorPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'supervisorResolveApproval').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'supervisorDismissEscalation').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'supervisorListDecisions').mockResolvedValue(decisions);
    vi.spyOn(tauri, 'supervisorRestart').mockResolvedValue(undefined);
    useStore.setState({
      supervisor: snapshot({
        approvals: [{ id: 'ap1', sessionId: 's1', projectId: 1, label: 'Sesja A', action: 'Wypchnięcie na main', detail: 'git push origin main', code: 'K7', channel: 'app', createdAt: 1 }],
        escalations: [{ id: 'es1', sessionId: 's2', projectId: 2, label: 'Sesja B', summary: 'Nie wiem co dalej', channel: 'app', createdAt: 1 }],
      }),
      supervisorPanelOpen: true,
    });
  });

  it('renders the supervisor terminal on Rozmowa', () => {
    render(<SupervisorPanel />);
    const terminal = screen.getByTestId('terminal');
    expect(terminal).toHaveAttribute('data-kind', 'supervisor');
    expect(terminal).toHaveAttribute('data-pty', 'p1');
  });

  it('shows the trust hint while running and not ready', () => {
    useStore.setState({ supervisor: snapshot({ ready: false }) });
    render(<SupervisorPanel />);
    expect(screen.getByText(/Yes, I trust this folder/)).toBeInTheDocument();
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
  });

  it('offers a restart when the agent is not running', () => {
    useStore.setState({ supervisor: snapshot({ running: false, ready: false, ptyId: null }) });
    render(<SupervisorPanel />);
    expect(screen.getByText('Agent nie działa')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Uruchom ponownie' }));
    expect(tauri.supervisorRestart).toHaveBeenCalled();
  });

  it('approves and rejects pending approvals', () => {
    render(<SupervisorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Do decyzji/ }));
    expect(screen.getByText('Sesja A')).toBeInTheDocument();
    expect(screen.getByText('git push origin main')).toBeInTheDocument();
    expect(screen.getByText('K7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź' }));
    expect(tauri.supervisorResolveApproval).toHaveBeenCalledWith('ap1', true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Odrzuć' })[0]);
    expect(tauri.supervisorResolveApproval).toHaveBeenCalledWith('ap1', false);
  });

  it('shows how long each approval and escalation has been waiting', () => {
    const now = Date.now();
    useStore.setState({
      supervisor: snapshot({
        approvals: [{ id: 'ap1', sessionId: 's1', projectId: 1, label: 'Sesja A', action: 'git push → main', detail: 'git push', code: 'K7', channel: 'app', createdAt: now - 12 * 60_000 }],
        escalations: [{ id: 'es1', sessionId: 's2', projectId: 2, label: 'Sesja B', summary: 'Nie wiem co dalej', channel: 'app', createdAt: now - 3 * 3_600_000 }],
      }),
    });
    render(<SupervisorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Do decyzji/ }));
    expect(screen.getByText('12 min temu')).toBeInTheDocument();
    expect(screen.getByText('3 h temu')).toBeInTheDocument();
  });

  it('opens the escalated session tab', () => {
    const openSessionTab = vi.fn();
    useStore.setState({ openSessionTab } as never);
    render(<SupervisorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Do decyzji/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Przejdź do sesji' }));
    expect(openSessionTab).toHaveBeenCalledWith(2, 's2', 'Sesja B');
    expect(useStore.getState().supervisorPanelOpen).toBe(false);
  });

  it('shows a Polish toast when approving fails', async () => {
    vi.mocked(toast.error).mockClear();
    vi.spyOn(tauri, 'supervisorResolveApproval').mockRejectedValue(new Error('boom'));
    render(<SupervisorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Do decyzji/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Zatwierdź' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Nie udało się zapisać decyzji: boom'));
  });

  it('dismisses an escalation', () => {
    render(<SupervisorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /Do decyzji/ }));
    const dismiss = screen.getAllByRole('button', { name: 'Odrzuć' })[1];
    fireEvent.click(dismiss);
    expect(tauri.supervisorDismissEscalation).toHaveBeenCalledWith('es1');
  });

  it('lists the decision log with Polish kind labels', async () => {
    render(<SupervisorPanel />);
    fireEvent.click(screen.getByRole('tab', { name: 'Dziennik' }));
    await waitFor(() => expect(tauri.supervisorListDecisions).toHaveBeenCalledWith(200));
    expect(await screen.findByText('Który plik zmienić?')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('Odpowiedź')).toBeInTheDocument();
    expect(screen.getByText('Zablokowane')).toBeInTheDocument();
  });

  it('closes without touching the pty', () => {
    render(<SupervisorPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Zamknij panel' }));
    expect(useStore.getState().supervisorPanelOpen).toBe(false);
  });
});
