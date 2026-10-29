import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { DiscordSetupStatus } from '../../types';
import { SupervisorDiscordSection } from './SupervisorDiscordSection';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const status = (over: Partial<DiscordSetupStatus> = {}): DiscordSetupStatus => ({
  bunPath: '/usr/bin/bun',
  tokenStored: true,
  bot: { name: 'AbeonCode', messageContentIntent: true, guildCount: 1 },
  botError: null,
  pairedUsers: 1,
  pendingPairings: 0,
  policy: 'allowlist',
  chatLinked: true,
  globalPluginEnabled: false,
  channelActive: true,
  blocker: null,
  ...over,
});

describe('SupervisorDiscordSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(toast.error).mockClear();
    vi.mocked(openUrl).mockClear();
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue(status());
    vi.spyOn(tauri, 'supervisorDiscordSaveToken').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'supervisorDiscordPair').mockResolvedValue(undefined);
    vi.spyOn(tauri, 'supervisorDiscordDisableGlobalPlugin').mockResolvedValue(undefined);
    useStore.setState({ supervisorDiscordEnabled: true, supervisorDiscordMuteWhenPresent: true });
  });

  it('hides the setup when Discord is off', () => {
    useStore.setState({ supervisorDiscordEnabled: false });
    render(<SupervisorDiscordSection />);
    expect(screen.getByLabelText('Rozmowa przez Discord')).not.toBeChecked();
    expect(screen.queryByText('Token bota zapisany')).toBeNull();
    expect(screen.queryByLabelText('Wyciszaj Discord, gdy jestem przy komputerze')).toBeNull();
    expect(tauri.supervisorDiscordStatus).not.toHaveBeenCalled();
  });

  it('toggles both settings', () => {
    render(<SupervisorDiscordSection />);
    fireEvent.click(screen.getByLabelText('Wyciszaj Discord, gdy jestem przy komputerze'));
    expect(useStore.getState().supervisorDiscordMuteWhenPresent).toBe(false);
    fireEvent.click(screen.getByLabelText('Rozmowa przez Discord'));
    expect(useStore.getState().supervisorDiscordEnabled).toBe(false);
  });

  it('shows the checklist from the status', async () => {
    render(<SupervisorDiscordSection />);
    expect(await screen.findByText('Bot: AbeonCode')).toBeInTheDocument();
    expect(screen.getByTestId('check-paired')).toHaveTextContent('✓');
    expect(screen.getByTestId('check-paired')).toHaveTextContent('Sparowany użytkownik');
    expect(screen.getByTestId('check-channel')).toHaveTextContent('✓');
    expect(screen.getByTestId('check-bun')).toHaveTextContent('/usr/bin/bun');
  });

  it('shows the blocker or the pairing wait for the agent row', async () => {
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue(
      status({ channelActive: false, blocker: 'Brak Buna' }),
    );
    const { unmount } = render(<SupervisorDiscordSection />);
    await screen.findByText('Bot: AbeonCode');
    expect(screen.getByTestId('check-channel')).toHaveTextContent('✗');
    expect(screen.getByTestId('check-channel')).toHaveTextContent('Brak Buna');
    unmount();

    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue(
      status({ channelActive: true, chatLinked: false }),
    );
    render(<SupervisorDiscordSection />);
    await screen.findByText('Bot: AbeonCode');
    expect(screen.getByTestId('check-channel')).toHaveTextContent('✗');
    expect(screen.getByTestId('check-channel')).toHaveTextContent('czeka na sparowanie');
  });

  it('shows the bot error and marks missing guilds', async () => {
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue(
      status({ bot: null, botError: 'Token odrzucony' }),
    );
    render(<SupervisorDiscordSection />);
    expect(await screen.findByText('Token odrzucony')).toBeInTheDocument();
    expect(screen.getByTestId('check-guild')).toHaveTextContent('✗');
    expect(screen.getByTestId('check-intent')).toHaveTextContent('✗');
  });

  it('shows an inline error when the status fails', async () => {
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockRejectedValue(new Error('boom'));
    render(<SupervisorDiscordSection />);
    expect(await screen.findByText(/Nie udało się pobrać stanu Discorda/)).toBeInTheDocument();
  });

  it('refreshes the status on demand', async () => {
    render(<SupervisorDiscordSection />);
    await screen.findByText('Bot: AbeonCode');
    fireEvent.click(screen.getByRole('button', { name: 'Odśwież' }));
    await waitFor(() => expect(tauri.supervisorDiscordStatus).toHaveBeenCalledTimes(2));
  });

  it('opens the developer portal', async () => {
    render(<SupervisorDiscordSection />);
    await screen.findByText('Bot: AbeonCode');
    fireEvent.click(screen.getByRole('button', { name: 'Otwórz Discord Developer Portal' }));
    expect(openUrl).toHaveBeenCalledWith('https://discord.com/developers/applications');
  });

  it('saves the token and clears the field', async () => {
    render(<SupervisorDiscordSection />);
    await screen.findByText('Bot: AbeonCode');
    const input = screen.getByLabelText('Token bota') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(input, { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz token' }));
    await waitFor(() => expect(tauri.supervisorDiscordSaveToken).toHaveBeenCalledWith('tok'));
    await waitFor(() => expect(input.value).toBe(''));
    await waitFor(() => expect(tauri.supervisorDiscordStatus).toHaveBeenCalledTimes(2));
  });

  it('keeps the token field and reports a failed save', async () => {
    vi.spyOn(tauri, 'supervisorDiscordSaveToken').mockRejectedValue(new Error('rejected'));
    render(<SupervisorDiscordSection />);
    await screen.findByText('Bot: AbeonCode');
    const input = screen.getByLabelText('Token bota') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zapisz token' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).not.toContain('secret-value');
    expect(input.value).toBe('secret-value');
    await waitFor(() => expect(tauri.supervisorDiscordStatus).toHaveBeenCalledTimes(2));
  });

  it('pairs with the typed code', async () => {
    render(<SupervisorDiscordSection />);
    await screen.findByText('Bot: AbeonCode');
    expect(screen.getByText(/odpowie kodem parowania/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Kod parowania'), { target: { value: ' 4f7541 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sparuj' }));
    await waitFor(() => expect(tauri.supervisorDiscordPair).toHaveBeenCalledWith('4f7541'));
  });

  it('hides pairing until the token is stored', async () => {
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue(
      status({ tokenStored: false, bot: null }),
    );
    render(<SupervisorDiscordSection />);
    await screen.findByTestId('check-token');
    expect(screen.queryByLabelText('Kod parowania')).toBeNull();
  });

  it('asks before disabling the global plugin', async () => {
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue(status({ globalPluginEnabled: true }));
    render(<SupervisorDiscordSection />);
    expect(await screen.findByText(/Wtyczka Discord jest włączona globalnie/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wyłącz globalnie' }));
    expect(screen.getByText(/enabledPlugins/)).toBeInTheDocument();
    expect(tauri.supervisorDiscordDisableGlobalPlugin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Potwierdź' }));
    await waitFor(() => expect(tauri.supervisorDiscordDisableGlobalPlugin).toHaveBeenCalled());
  });

  it('cancels the global plugin confirmation', async () => {
    vi.spyOn(tauri, 'supervisorDiscordStatus').mockResolvedValue(status({ globalPluginEnabled: true }));
    render(<SupervisorDiscordSection />);
    await screen.findByText(/Wtyczka Discord jest włączona globalnie/);
    fireEvent.click(screen.getByRole('button', { name: 'Wyłącz globalnie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anuluj' }));
    expect(screen.queryByText(/enabledPlugins/)).toBeNull();
    expect(tauri.supervisorDiscordDisableGlobalPlugin).not.toHaveBeenCalled();
  });
});
