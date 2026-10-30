import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '../../store';
import { SessionFooter } from './SessionFooter';

describe('SessionFooter', () => {
  it('explains the resume and continues in the terminal', () => {
    const setSessionMode = vi.fn();
    useStore.setState({ setSessionMode });
    render(<SessionFooter sessionId="1bccf2a7-aaaa-bbbb" tabId="session:s1" />);
    expect(screen.getByText(/Kontynuacja zamieni historię na terminal:/)).toBeTruthy();
    expect(screen.getByText('claude --resume 1bccf2a7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kontynuuj w terminalu' }));
    expect(setSessionMode).toHaveBeenCalledWith('session:s1', 'terminal');
  });

  it('offers the transcript export as a secondary action', () => {
    render(<SessionFooter sessionId="1bccf2a7-aaaa-bbbb" tabId="session:s1" />);
    expect(screen.getByRole('button', { name: 'Eksportuj transkrypt' })).toBeTruthy();
  });
});
