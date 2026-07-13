import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupContextMenu } from './GroupContextMenu';

describe('GroupContextMenu', () => {
  it('fires onDetach then onCloseMenu', () => {
    const onDetach = vi.fn();
    const onCloseMenu = vi.fn();
    render(<GroupContextMenu onDetach={onDetach} onCloseMenu={onCloseMenu} />);
    fireEvent.click(screen.getByText('Wydziel do nowego okna'));
    expect(onDetach).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });
});
