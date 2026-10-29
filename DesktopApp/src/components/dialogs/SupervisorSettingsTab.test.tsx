import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { SupervisorSettingsTab } from './SupervisorSettingsTab';

describe('SupervisorSettingsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(tauri, 'detectClaudeOptions').mockResolvedValue({
      models: [
        { modelId: 'claude-opus-5-5', family: 'opus', source: 'binary', latest: true },
        { modelId: 'claude-opus-4-8', family: 'opus', source: 'binary', latest: false },
      ],
      effortLevels: ['low', 'high'],
    });
    vi.spyOn(tauri, 'supervisorNewConversation').mockResolvedValue(undefined);
    useStore.setState({
      supervisorLevel: 'off',
      supervisorGraceSeconds: 60,
      supervisorPresenceMinutes: 5,
      supervisorModelId: '',
      supervisorExtraRules: [],
    });
  });

  it('sets the level when Asystent (zalecany) is chosen', () => {
    render(<SupervisorSettingsTab />);
    const option = screen.getByRole('option', { name: 'Asystent (zalecany)' }) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('Poziom'), { target: { value: option.value } });
    expect(useStore.getState().supervisorLevel).toBe('assistant');
  });

  it('offers all four level labels', () => {
    render(<SupervisorSettingsTab />);
    for (const label of ['Wyłączony', 'Przekaźnik', 'Asystent (zalecany)', 'Samodzielny']) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('lists the built-in production rules read-only', () => {
    render(<SupervisorSettingsTab />);
    expect(screen.getByText(/git push → main\/master/)).toBeInTheDocument();
    expect(screen.getByText(/task release/)).toBeInTheDocument();
    expect(screen.getByText(/gh pr merge/)).toBeInTheDocument();
    expect(screen.getByText(/bkt pr merge/)).toBeInTheDocument();
    expect(screen.getByText(/deployment_\*/)).toBeInTheDocument();
  });

  it('commits grace seconds and presence minutes with clamping on blur', () => {
    render(<SupervisorSettingsTab />);
    const grace = screen.getByLabelText('Karencja (s)');
    fireEvent.change(grace, { target: { value: '5' } });
    fireEvent.blur(grace);
    expect(useStore.getState().supervisorGraceSeconds).toBe(15);
    const presence = screen.getByLabelText('Próg obecności (min)');
    fireEvent.change(presence, { target: { value: '12' } });
    fireEvent.blur(presence);
    expect(useStore.getState().supervisorPresenceMinutes).toBe(12);
  });

  it('stores extra rules trimmed without empty lines', () => {
    render(<SupervisorSettingsTab />);
    const area = screen.getByLabelText('Dodatkowe reguły');
    fireEvent.change(area, { target: { value: '  bash:^rm -rf  \n\n mcp:foo__*\n' } });
    fireEvent.blur(area);
    expect(useStore.getState().supervisorExtraRules).toEqual(['bash:^rm -rf', 'mcp:foo__*']);
  });

  it('keeps typed extra rules when the tab closes before the field blurs', () => {
    const { unmount } = render(<SupervisorSettingsTab />);
    fireEvent.change(screen.getByLabelText('Dodatkowe reguły'), { target: { value: ' bash:^make deploy \n' } });
    unmount();
    expect(useStore.getState().supervisorExtraRules).toEqual(['bash:^make deploy']);
  });

  it('writes nothing on close when the rules did not change', () => {
    useStore.setState({ supervisorExtraRules: ['mcp:foo__*'] });
    const setter = vi.fn();
    useStore.setState({ setSupervisorExtraRules: setter });
    const { unmount } = render(<SupervisorSettingsTab />);
    unmount();
    expect(setter).not.toHaveBeenCalled();
  });

  it('describes what each level decides', () => {
    render(<SupervisorSettingsTab />);
    const choose = (label: string) => {
      const option = screen.getByRole('option', { name: label }) as HTMLOptionElement;
      fireEvent.change(screen.getByLabelText('Poziom'), { target: { value: option.value } });
    };
    choose('Przekaźnik');
    expect(screen.getByText(/niczego nie rozstrzyga/)).toBeInTheDocument();
    expect(screen.getByText(/każde pytanie sesji przekazuje Tobie/)).toBeInTheDocument();
    choose('Asystent (zalecany)');
    expect(screen.getByText(/po karencji, gdy jesteś przy komputerze, od razu, gdy Cię nie ma/)).toBeInTheDocument();
    expect(screen.getByText(/Nowe sesje otwiera tylko na Twoją prośbę/)).toBeInTheDocument();
    choose('Samodzielny');
    expect(screen.getByText(/Jak Asystent/)).toBeInTheDocument();
    expect(screen.getByText(/może sam otwierać nowe sesje/)).toBeInTheDocument();
  });

  it('explains that sessions started while switched off stay unsupervised', () => {
    render(<SupervisorSettingsTab />);
    expect(screen.getByText(/uruchomione, gdy agent był wyłączony, nie są nadzorowane/)).toBeInTheDocument();
  });

  it('selects the model from the detected Claude models, with Domyślny as empty', async () => {
    useStore.setState({ supervisorModelId: 'claude-opus-5-5' });
    render(<SupervisorSettingsTab />);
    await screen.findByRole('option', { name: 'Opus 5.5' });
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(select.value).toBe('claude-opus-5-5');
    fireEvent.change(select, { target: { value: '' } });
    expect(useStore.getState().supervisorModelId).toBe('');
    expect(screen.getByRole('option', { name: 'Domyślny' })).toBeInTheDocument();
  });

  it('starts a new conversation', async () => {
    render(<SupervisorSettingsTab />);
    fireEvent.click(screen.getByText('Nowa rozmowa agenta'));
    await waitFor(() => expect(tauri.supervisorNewConversation).toHaveBeenCalled());
  });

  it('shows an error when the new conversation fails', async () => {
    vi.spyOn(tauri, 'supervisorNewConversation').mockRejectedValue(new Error('boom'));
    render(<SupervisorSettingsTab />);
    fireEvent.click(screen.getByText('Nowa rozmowa agenta'));
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
  });
});
