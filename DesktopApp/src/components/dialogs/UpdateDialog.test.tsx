import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { UpdateDialog } from './UpdateDialog';

afterEach(cleanup);

describe('UpdateDialog', () => {
  const base = { version: '0.2.0', notes: 'Lista zmian', busy: false, progress: null,
    onUpdate: () => {}, onLater: () => {} };

  it('shows the new version and notes', () => {
    render(<UpdateDialog {...base} />);
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText('Lista zmian')).toBeInTheDocument();
  });

  it('calls onUpdate when the update button is clicked', () => {
    const onUpdate = vi.fn();
    render(<UpdateDialog {...base} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zaktualizuj' }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('disables buttons and shows percent while busy', () => {
    render(<UpdateDialog {...base} busy progress={0.5} />);
    expect(screen.getByRole('button', { name: /Pobieranie/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Później' })).toBeDisabled();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('calls onLater when the later button is clicked', () => {
    const onLater = vi.fn();
    render(<UpdateDialog {...base} onLater={onLater} />);
    fireEvent.click(screen.getByRole('button', { name: 'Później' }));
    expect(onLater).toHaveBeenCalledOnce();
  });

  it('omits the notes block when notes is empty', () => {
    const { container } = render(<UpdateDialog {...base} notes="" />);
    expect(container.querySelector('pre')).toBeNull();
  });

  it('hides the progress bar when busy but progress is null', () => {
    render(<UpdateDialog {...base} busy progress={null} />);
    expect(screen.queryByText(/%/)).toBeNull();
  });
});
