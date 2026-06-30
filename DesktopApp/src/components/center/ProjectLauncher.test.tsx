import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '../../store';
import { ProjectLauncher } from './ProjectLauncher';

Element.prototype.scrollIntoView = vi.fn();

const openSession = vi.fn();
const openTerminal = vi.fn();

function open() {
  fireEvent.keyDown(document.body, { key: 'n', ctrlKey: true, shiftKey: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    projects: [
      { id: 1, name: 'alpha', path: '/p/alpha' },
      { id: 2, name: 'beta', path: '/p/beta' },
    ] as never,
    sortMode: 'alpha',
    shortcutOverrides: {},
    openNewSessionTab: openSession,
    openNewTerminalTab: openTerminal,
  });
});

describe('ProjectLauncher', () => {
  it('renders nothing until the shortcut is pressed', () => {
    render(<ProjectLauncher />);
    expect(screen.queryByPlaceholderText('Szukaj projektu…')).toBeNull();
  });

  it('opens with the search input focused and the first row selected', () => {
    render(<ProjectLauncher />);
    open();
    const input = screen.getByPlaceholderText('Szukaj projektu…');
    expect(input).toHaveFocus();
    expect(screen.getByText('alpha')).toBeInTheDocument();
  });

  it('Enter starts a new session in the highlighted project', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.keyDown(screen.getByPlaceholderText('Szukaj projektu…'), { key: 'Enter' });
    expect(openSession).toHaveBeenCalledWith(1);
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('ArrowDown then Enter targets the second project', () => {
    render(<ProjectLauncher />);
    open();
    const input = screen.getByPlaceholderText('Szukaj projektu…');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(openSession).toHaveBeenCalledWith(2);
  });

  it('Ctrl+Enter opens a terminal in the highlighted project', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.keyDown(screen.getByPlaceholderText('Szukaj projektu…'), { key: 'Enter', ctrlKey: true });
    expect(openTerminal).toHaveBeenCalledWith(1);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('resets the selection to the first row when the query changes', () => {
    render(<ProjectLauncher />);
    open();
    const input = screen.getByPlaceholderText('Szukaj projektu…');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(openSession).toHaveBeenCalledWith(1);
  });

  it('filters by path', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.change(screen.getByPlaceholderText('Szukaj projektu…'), { target: { value: '/p/beta' } });
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('Escape closes the overlay', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.keyDown(screen.getByPlaceholderText('Szukaj projektu…'), { key: 'Escape' });
    expect(screen.queryByPlaceholderText('Szukaj projektu…')).toBeNull();
  });

  it('clicking a project row starts a new session for that project', () => {
    render(<ProjectLauncher />);
    open();
    fireEvent.mouseDown(screen.getByText('beta'));
    expect(openSession).toHaveBeenCalledWith(2);
  });

  it('clicking the backdrop closes the overlay without launching', () => {
    render(<ProjectLauncher />);
    open();
    const backdrop = screen.getByPlaceholderText('Szukaj projektu…').closest('.fixed');
    fireEvent.mouseDown(backdrop!);
    expect(screen.queryByPlaceholderText('Szukaj projektu…')).toBeNull();
    expect(openSession).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
  });
});
