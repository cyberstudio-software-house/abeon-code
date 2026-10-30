import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '../../../store';
import { PermissionsCategory } from './PermissionsCategory';

describe('PermissionsCategory', () => {
  beforeEach(() => {
    useStore.setState({ skipPermissions: false });
  });

  it('shows the skip toggle as a switch with the flag in its description', () => {
    render(<PermissionsCategory />);
    const toggle = screen.getByRole('switch', { name: 'Pomijaj pytania o uprawnienia' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('--dangerously-skip-permissions')).toBeInTheDocument();
  });

  it('turns skipping permissions on and off', () => {
    render(<PermissionsCategory />);
    const toggle = screen.getByRole('switch', { name: 'Pomijaj pytania o uprawnienia' });

    fireEvent.click(toggle);
    expect(useStore.getState().skipPermissions).toBe(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    expect(useStore.getState().skipPermissions).toBe(false);
  });
});
