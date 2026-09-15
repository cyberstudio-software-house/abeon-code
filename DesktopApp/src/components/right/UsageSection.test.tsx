import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UsageSection } from './UsageSection';

type MockState = Record<string, unknown>;
let mockState: MockState;

vi.mock('../../lib/tauri', () => ({
  tauri: {
    sessionUsage: vi.fn().mockResolvedValue(null),
    onSessionUsage: vi.fn().mockResolvedValue(() => {}),
    providerLimits: vi.fn((provider: string) => Promise.resolve(provider === 'codex' ? {
      shortWindow: { usedPercent: 24, windowMinutes: 300, resetsAt: 1789459200 },
      weekly: { usedPercent: 67, windowMinutes: 10080, resetsAt: 1789678800 },
    } : {
      shortWindow: null,
      weekly: null,
    })),
  },
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: MockState) => unknown) => selector(mockState),
}));

describe('UsageSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState = {
      tabs: [{
        kind: 'session',
        id: 'session:abc',
        projectId: 1,
        sessionId: 'abc',
        title: 'Codex session',
        mode: 'terminal',
        provider: 'codex',
      }],
      activeTabId: 'session:abc',
    };
  });

  it('shows provider limits by default without an additional section heading', async () => {
    render(<UsageSection />);

    expect(screen.getByRole('tab', { name: 'Limity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Zużycie' })).toHaveAttribute('aria-selected', 'false');
    expect(await screen.findByText('5 godzin')).toBeInTheDocument();
    expect(screen.getByText('Tydzień')).toBeInTheDocument();
    expect(screen.getByText('24%')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getAllByText('Zużycie')).toHaveLength(1);
    expect(screen.getAllByText(/^Reset:/)).toHaveLength(2);
  });

  it('switches to session usage details', () => {
    render(<UsageSection />);

    fireEvent.click(screen.getByRole('tab', { name: 'Zużycie' }));

    expect(screen.getByText('Sesja')).toBeInTheDocument();
    expect(screen.getByText('Czas sesji')).toBeInTheDocument();
    expect(screen.getByText('Czas aktywny')).toBeInTheDocument();
    expect(screen.queryByText('5 godzin')).not.toBeInTheDocument();
  });

  it('shows an empty limits state when no session is active', () => {
    mockState = { tabs: [], activeTabId: null };

    render(<UsageSection />);

    expect(screen.getByText('Brak danych o limitach')).toBeInTheDocument();
  });
});
