import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployCategory } from './DeployCategory';

vi.mock('../../../lib/tauri', () => ({
  tauri: {
    deployGetSettings: vi.fn(),
    deploySetVpnConnection: vi.fn(),
    deployToolsStatus: vi.fn(),
  },
}));
import { tauri } from '../../../lib/tauri';

const VPN_LABEL = 'Nazwa połączenia w NetworkManagerze';

describe('DeployCategory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauri.deployGetSettings).mockResolvedValue({ vpnConnection: null, vpnSupported: true });
    vi.mocked(tauri.deploySetVpnConnection).mockResolvedValue(undefined);
    vi.mocked(tauri.deployToolsStatus).mockResolvedValue([]);
  });

  it('prefills the stored connection name', async () => {
    vi.mocked(tauri.deployGetSettings).mockResolvedValue({ vpnConnection: 'Office VPN', vpnSupported: true });
    render(<DeployCategory />);
    expect(((await screen.findByLabelText(VPN_LABEL)) as HTMLInputElement).value).toBe('Office VPN');
    expect(screen.getByText(
      'Gdy klaster jest niedostępny, aplikacja spróbuje włączyć to połączenie i dokończy sprawdzanie wdrożenia.',
    )).toBeInTheDocument();
  });

  it('saves the trimmed name on blur', async () => {
    render(<DeployCategory />);
    const input = (await screen.findByLabelText(VPN_LABEL)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  Office VPN  ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(tauri.deploySetVpnConnection).toHaveBeenCalledWith('Office VPN'));
    expect(tauri.deploySetVpnConnection).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(input.value).toBe('Office VPN'));
  });

  it('sends null for a blank name and skips an unchanged one', async () => {
    vi.mocked(tauri.deployGetSettings).mockResolvedValue({ vpnConnection: 'Office VPN', vpnSupported: true });
    render(<DeployCategory />);
    const input = (await screen.findByLabelText(VPN_LABEL)) as HTMLInputElement;
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: ' Office VPN ' } });
    fireEvent.blur(input);
    expect(tauri.deploySetVpnConnection).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(tauri.deploySetVpnConnection).toHaveBeenCalledWith(null));
  });

  it('shows the backend error and keeps the typed text', async () => {
    vi.mocked(tauri.deploySetVpnConnection).mockRejectedValue({
      code: 'other',
      message: 'Nazwa połączenia zawiera niedozwolone znaki',
    });
    render(<DeployCategory />);
    const input = (await screen.findByLabelText(VPN_LABEL)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a;b' } });
    fireEvent.blur(input);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nazwa połączenia zawiera niedozwolone znaki');
    expect(input.value).toBe('a;b');
  });

  it('replaces the field with a note when the platform has no VPN support', async () => {
    vi.mocked(tauri.deployGetSettings).mockResolvedValue({ vpnConnection: null, vpnSupported: false });
    render(<DeployCategory />);
    expect(await screen.findByText('Automatyczne łączenie z VPN działa tylko na Linuksie.')).toBeInTheDocument();
    expect(screen.queryByLabelText(VPN_LABEL)).toBeNull();
  });

  it('lists every tool with its status and detail', async () => {
    vi.mocked(tauri.deployToolsStatus).mockResolvedValue([
      { tool: 'bkt', found: true, detail: 'bkt 1.2.3' },
      { tool: 'gh', found: false, detail: 'nie znaleziono' },
      { tool: 'kubectl', found: true, detail: 'Client Version: v1.30.0' },
    ]);
    render(<DeployCategory />);
    expect(await screen.findByText('bkt 1.2.3')).toBeInTheDocument();
    expect(screen.getByText('Client Version: v1.30.0')).toBeInTheDocument();
    expect(screen.getByText('nie znaleziono')).toBeInTheDocument();
    expect(screen.getAllByText('Znaleziono')).toHaveLength(2);
    expect(screen.getAllByText('Nie znaleziono')).toHaveLength(1);
    expect(screen.queryByText('nmcli')).toBeNull();
  });

  it('shows an error when the tools cannot be checked', async () => {
    vi.mocked(tauri.deployToolsStatus).mockRejectedValue('powłoka niedostępna');
    render(<DeployCategory />);
    expect(await screen.findByText('powłoka niedostępna')).toBeInTheDocument();
  });

  it('explains when Discord notifications are sent', async () => {
    render(<DeployCategory />);
    await screen.findByLabelText(VPN_LABEL);
    expect(screen.getByRole('heading', { name: 'Powiadomienia na Discordzie' })).toBeInTheDocument();
    expect(screen.getByText(/trafiają na Discord tylko wtedy, gdy agent sterujący jest włączony i ma podłączony Discord/))
      .toBeInTheDocument();
  });
});
