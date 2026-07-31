import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageSection } from './UsageSection';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    sessionUsage: vi.fn().mockResolvedValue(null),
    onSessionUsage: vi.fn().mockResolvedValue(() => {}),
  },
}));

vi.mock('../../store', () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({ tabs: [], activeTabId: null }),
}));

describe('UsageSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders session, duration and active-time lines with placeholders when no active tab', () => {
    render(<UsageSection />);
    expect(screen.getByText('Sesja')).toBeInTheDocument();
    expect(screen.getByText('Czas sesji')).toBeInTheDocument();
    expect(screen.getByText('Czas aktywny')).toBeInTheDocument();
    expect(screen.queryByText('Projekt')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBe(3);
  });
});
