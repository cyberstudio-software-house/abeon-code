import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabContextMenu } from './TabContextMenu';

const noop = () => {};

describe('TabContextMenu', () => {
  it('renders all three items', () => {
    render(<TabContextMenu canDetach onDetach={noop} onRename={noop} onClose={noop} onCloseMenu={noop} />);
    expect(screen.getByText('Otwórz w nowym oknie')).toBeInTheDocument();
    expect(screen.getByText('Zmień nazwę')).toBeInTheDocument();
    expect(screen.getByText('Zamknij')).toBeInTheDocument();
  });

  it('fires onDetach then onCloseMenu', () => {
    const onDetach = vi.fn(); const onCloseMenu = vi.fn();
    render(<TabContextMenu canDetach onDetach={onDetach} onRename={noop} onClose={noop} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Otwórz w nowym oknie'));
    expect(onDetach).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('disables detach when canDetach is false', () => {
    const onDetach = vi.fn();
    render(<TabContextMenu canDetach={false} onDetach={onDetach} onRename={noop} onClose={noop} onCloseMenu={noop} />);
    fireEvent.click(screen.getByText('Otwórz w nowym oknie'));
    expect(onDetach).not.toHaveBeenCalled();
  });

  it('fires onRename then onCloseMenu', () => {
    const onRename = vi.fn(); const onCloseMenu = vi.fn();
    render(<TabContextMenu canDetach onDetach={noop} onRename={onRename} onClose={noop} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Zmień nazwę'));
    expect(onRename).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('fires onClose then onCloseMenu', () => {
    const onClose = vi.fn(); const onCloseMenu = vi.fn();
    render(<TabContextMenu canDetach onDetach={noop} onRename={noop} onClose={onClose} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Zamknij'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });
});
