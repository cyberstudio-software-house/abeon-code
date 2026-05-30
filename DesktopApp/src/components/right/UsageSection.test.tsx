import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageSection } from './UsageSection';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    sessionUsage: vi.fn().mockResolvedValue(null),
    projectUsage: vi.fn().mockResolvedValue(null),
    onSessionUsage: vi.fn().mockResolvedValue(() => {}),
  },
}));

vi.mock('../../store', () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({ tabs: [], activeTabId: null }),
}));

describe('UsageSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders Sesja and Projekt lines with placeholder when no active tab', () => {
    render(<UsageSection />);
    expect(screen.getByText('Sesja')).toBeInTheDocument();
    expect(screen.getByText('Projekt')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBe(2);
  });
});
