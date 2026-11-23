import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import { openUrl } from '@tauri-apps/plugin-opener';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { makeView } from '../../test-helpers/deploy';
import type { Tab } from '../../store/tabsSlice';
import { DeployDetailsDialog } from './DeployDetailsDialog';

const sessionTab = (overrides: Partial<Extract<Tab, { kind: 'session' }>> = {}): Tab => ({
  kind: 'session',
  id: 'session:s1',
  projectId: 1,
  sessionId: 's1',
  ptyId: 'pty-1',
  title: 'Sesja jeden',
  mode: 'terminal',
  ...overrides,
});

const encode = (text: string) => btoa(unescape(encodeURIComponent(text)));

describe('DeployDetailsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    useStore.setState({ trackings: [], tabs: [], activeAgentPtyId: null });
    vi.spyOn(tauri, 'deployRetry').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'deployDismiss').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'ptyWrite').mockResolvedValue(undefined);
  });

  const renderDialog = (onClose = vi.fn()) => render(<DeployDetailsDialog projectId={1} onClose={onClose} />);

  it('shows the repository, the short commit and the stage times', () => {
    const today = (hours: number, minutes: number) => {
      const date = new Date();
      date.setHours(hours, minutes, 0, 0);
      return date.getTime();
    };
    useStore.setState({
      trackings: [makeView({
        state: 'delivering',
        runId: '12',
        startedAt: today(10, 0),
        buildFinishedAt: today(10, 5),
      })],
    });
    renderDialog();
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText('abcdef1')).toBeInTheDocument();
    expect(screen.getByText('Budowanie: 10:00 – 10:05')).toBeInTheDocument();
    expect(screen.getByText('Wdrażanie na klaster: 10:05 – trwa')).toBeInTheDocument();
  });

  it('shows no stage line for a stall from waitingForRun and the date of an old tracking', () => {
    useStore.setState({
      trackings: [makeView({ id: 1, state: 'stalled', repoPath: '/a', startedAt: Date.now(), finishedAt: Date.now() })],
    });
    const { unmount } = renderDialog();
    expect(screen.queryByText(/Budowanie:/)).toBeNull();
    unmount();

    const old = new Date(2020, 0, 5, 10, 0).getTime();
    useStore.setState({ trackings: [makeView({ id: 2, state: 'building', runId: '3', startedAt: old })] });
    renderDialog();
    expect(screen.getByText('Budowanie: 05.01 10:00 – trwa')).toBeInTheDocument();
  });

  it('keeps the blocker text and the retry button for a paused tracking', async () => {
    useStore.setState({
      trackings: [makeView({ id: 9, state: 'paused', clusterBlocker: { type: 'clusterUnreachable' } })],
    });
    renderDialog();
    expect(screen.getByText(/Nie mogę połączyć się z klastrem/)).toBeInTheDocument();
    expect(screen.getByText('Pipeline czeka na Ciebie')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    await waitFor(() => expect(tauri.deployRetry).toHaveBeenCalledWith(9));
  });

  it('opens the pipeline with the run url', () => {
    useStore.setState({ trackings: [makeView({ state: 'building', runUrl: 'https://ci.example/run/1' })] });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz pipeline' }));
    expect(openUrl).toHaveBeenCalledWith('https://ci.example/run/1');
  });

  it('has no pipeline button without a run url', () => {
    useStore.setState({ trackings: [makeView({ state: 'building' })] });
    renderDialog();
    expect(screen.queryByRole('button', { name: 'Otwórz pipeline' })).toBeNull();
  });

  it('offers a retry only with a blocker and calls deployRetry', async () => {
    useStore.setState({ trackings: [makeView({ id: 7, state: 'building', ciBlocker: { type: 'clusterUnreachable' } })] });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    await waitFor(() => expect(tauri.deployRetry).toHaveBeenCalledWith(7));
  });

  it('has no retry without a blocker', () => {
    useStore.setState({ trackings: [makeView({ state: 'building' })] });
    renderDialog();
    expect(screen.queryByRole('button', { name: 'Spróbuj ponownie' })).toBeNull();
  });

  it('shows the reason and the tool of an unavailable tool', () => {
    useStore.setState({
      trackings: [makeView({
        state: 'building',
        ciBlocker: { type: 'toolUnavailable', tool: 'bkt', reason: 'brak logowania' },
      })],
    });
    renderDialog();
    expect(screen.getByText(/brak logowania/)).toBeInTheDocument();
    expect(screen.getByText(/bkt/)).toBeInTheDocument();
  });

  it('shows the build number line only when an image carries it', () => {
    useStore.setState({
      trackings: [makeView({ state: 'delivering', buildNumber: 42, currentImages: ['reg/app:1.42'] })],
    });
    const { unmount } = renderDialog();
    expect(screen.getByText('Obraz zawiera numer builda 42')).toBeInTheDocument();
    unmount();
    useStore.setState({
      trackings: [makeView({ state: 'delivering', buildNumber: 42, currentImages: ['reg/app:1.41'] })],
    });
    renderDialog();
    expect(screen.queryByText(/Obraz zawiera numer builda/)).toBeNull();
  });

  it('renders the log excerpt of a failure', () => {
    useStore.setState({
      trackings: [makeView({
        state: 'failed',
        failure: { stage: 'build', reason: 'tests failed', logExcerpt: 'FAIL src/a.test.ts\nexpected 1' },
      })],
    });
    renderDialog();
    const log = screen.getByText(/FAIL src\/a.test.ts/);
    expect(log.tagName).toBe('PRE');
    expect(log).toHaveTextContent('expected 1');
  });

  it('hides a closed tracking with Ukryj and not an open one', async () => {
    useStore.setState({ trackings: [makeView({ id: 3, state: 'succeeded' })] });
    const { unmount } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Ukryj' }));
    await waitFor(() => expect(tauri.deployDismiss).toHaveBeenCalledWith(3));
    unmount();
    useStore.setState({ trackings: [makeView({ id: 4, state: 'building' })] });
    renderDialog();
    expect(screen.queryByRole('button', { name: 'Ukryj' })).toBeNull();
  });

  describe('Wyślij do sesji', () => {
    const failed = () => makeView({
      state: 'failed',
      failure: { stage: 'build', reason: 'tests failed', logExcerpt: 'line 1\nline 2' },
    });

    it('is absent for a tracking that did not fail', () => {
      useStore.setState({ trackings: [makeView({ state: 'building' })], tabs: [sessionTab()] });
      renderDialog();
      expect(screen.queryByRole('button', { name: 'Wyślij do sesji' })).toBeNull();
    });

    it('is disabled with no open agent session', () => {
      useStore.setState({ trackings: [failed()], tabs: [] });
      renderDialog();
      expect(screen.getByRole('button', { name: 'Wyślij do sesji' })).toBeDisabled();
    });

    it('ignores sessions of other projects, history tabs and tabs without a pty', () => {
      useStore.setState({
        trackings: [failed()],
        tabs: [
          sessionTab({ id: 'session:a', projectId: 2 }),
          sessionTab({ id: 'session:b', mode: 'history' }),
          sessionTab({ id: 'session:c', ptyId: undefined }),
        ],
      });
      renderDialog();
      expect(screen.getByRole('button', { name: 'Wyślij do sesji' })).toBeDisabled();
    });

    it('types the single-line summary without Enter into the chosen session', async () => {
      useStore.setState({ trackings: [failed()], tabs: [sessionTab()] });
      const onClose = vi.fn();
      renderDialog(onClose);
      fireEvent.click(screen.getByRole('button', { name: 'Wyślij do sesji' }));
      await waitFor(() => expect(tauri.ptyWrite).toHaveBeenCalledTimes(1));
      const expected = 'Wdrożenie abcdef1 nie powiodło się na etapie budowania: tests failed line 1 line 2';
      expect(tauri.ptyWrite).toHaveBeenCalledWith('pty-1', encode(expected));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('sends to the session picked in the select', async () => {
      useStore.setState({
        trackings: [failed()],
        tabs: [sessionTab(), sessionTab({ id: 'session:s2', sessionId: 's2', ptyId: 'pty-2', title: 'Sesja dwa' })],
      });
      renderDialog();
      fireEvent.change(screen.getByRole('combobox', { name: 'Sesja' }), { target: { value: 'pty-2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Wyślij do sesji' }));
      await waitFor(() => expect(tauri.ptyWrite).toHaveBeenCalledWith('pty-2', expect.any(String)));
    });

    it('preselects the active agent session', async () => {
      useStore.setState({
        trackings: [failed()],
        tabs: [sessionTab(), sessionTab({ id: 'session:s2', sessionId: 's2', ptyId: 'pty-2', title: 'Sesja dwa' })],
        activeAgentPtyId: 'pty-2',
      });
      renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Wyślij do sesji' }));
      await waitFor(() => expect(tauri.ptyWrite).toHaveBeenCalledWith('pty-2', expect.any(String)));
    });

    it('strips control characters from the typed text', async () => {
      const view = makeView({
        state: 'failed',
        failure: { stage: 'delivery', reason: 'bad\u001b[2J', logExcerpt: 'ok\rrm -rf /\u0007' },
      });
      useStore.setState({ trackings: [view], tabs: [sessionTab()] });
      renderDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Wyślij do sesji' }));
      await waitFor(() => expect(tauri.ptyWrite).toHaveBeenCalled());
      const typed = decodeURIComponent(escape(atob(vi.mocked(tauri.ptyWrite).mock.calls[0][1])));
      expect(typed).toBe('Wdrożenie abcdef1 nie powiodło się na etapie wdrażania na klaster: bad[2J ok rm -rf /');
      expect(typed).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    });
  });
});
