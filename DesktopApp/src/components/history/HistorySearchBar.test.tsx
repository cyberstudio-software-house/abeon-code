import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistorySearchBar } from './HistorySearchBar';

function setup(overrides = {}) {
  const props = {
    query: '',
    onQueryChange: vi.fn(),
    count: 0,
    activeIndex: -1,
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    hasOlderUnloaded: false,
    ...overrides,
  };
  render(<HistorySearchBar {...props} />);
  return props;
}

describe('HistorySearchBar', () => {
  it('shows "0 wyników" when there is a query but no matches', () => {
    setup({ query: 'zzz', count: 0 });
    expect(screen.getByText('0 wyników')).toBeTruthy();
  });

  it('shows the active position out of total', () => {
    setup({ query: 'beta', count: 3, activeIndex: 1 });
    expect(screen.getByText('2/3')).toBeTruthy();
  });

  it('calls onQueryChange when typing', () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText('Szukaj w sesji…'), { target: { value: 'x' } });
    expect(props.onQueryChange).toHaveBeenCalledWith('x');
  });

  it('Enter triggers next, Shift+Enter triggers prev, Escape closes', () => {
    const props = setup({ query: 'beta', count: 2 });
    const input = screen.getByPlaceholderText('Szukaj w sesji…');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onNext).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(props.onPrev).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('shows a note when older messages are not loaded', () => {
    setup({ hasOlderUnloaded: true });
    expect(screen.getByText(/starsze wiadomości nie są wczytane/i)).toBeTruthy();
  });
});
