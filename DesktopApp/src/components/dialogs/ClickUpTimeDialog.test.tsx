import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClickUpTimeDialog } from './ClickUpTimeDialog';

vi.mock('../../store', () => ({
  useStore: (sel: (s: unknown) => unknown) => sel({
    tabs: [{ kind: 'session', id: 'tab-1', projectId: 1, sessionId: 's1', title: 'S', mode: 'terminal', provider: 'claude' }],
    activeTabId: 'tab-1',
  }),
}));
vi.mock('../../lib/tauri', () => ({ tauri: {
  clickupEstimateTime: vi.fn().mockResolvedValue({ sessionMs: 1_800_000, devEstimateMs: 5_400_000 }),
  clickupLogTime: vi.fn().mockResolvedValue(undefined),
}}));
import { tauri } from '../../lib/tauri';

describe('ClickUpTimeDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('logs the proposed time', async () => {
    render(<ClickUpTimeDialog projectId={1} taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect(tauri.clickupEstimateTime).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('Zapisz czas'));
    await waitFor(() => expect(tauri.clickupLogTime).toHaveBeenCalled());
    const [, , durationMs] = (tauri.clickupLogTime as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(durationMs as number).toBeGreaterThanOrEqual(1_800_000);
    expect(durationMs as number).toBeLessThanOrEqual(5_400_000);
  });

  it('falls back to the proposed time when the override is non-numeric', async () => {
    render(<ClickUpTimeDialog projectId={1} taskId="t1" onClose={() => {}} />);
    await waitFor(() => expect(tauri.clickupEstimateTime).toHaveBeenCalled());
    fireEvent.change(await screen.findByPlaceholderText('60'), { target: { value: 'abc' } });
    fireEvent.click(await screen.findByText('Zapisz czas'));
    await waitFor(() => expect(tauri.clickupLogTime).toHaveBeenCalled());
    const [, , durationMs] = (tauri.clickupLogTime as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(Number.isFinite(durationMs as number)).toBe(true);
    expect(durationMs as number).toBeGreaterThanOrEqual(1_800_000);
    expect(durationMs as number).toBeLessThanOrEqual(5_400_000);
  });
});
