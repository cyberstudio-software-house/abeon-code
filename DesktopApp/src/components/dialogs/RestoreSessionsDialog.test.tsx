import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { RestoreSessionsDialog } from './RestoreSessionsDialog';

const sessions = [
  { id: 'session:a', title: 'Naprawa importu', projectName: 'carimporter' },
  { id: 'session:b', title: 'Panel EN', projectName: null },
];

describe('RestoreSessionsDialog', () => {
  it('lists every session together with its project', () => {
    render(<RestoreSessionsDialog sessions={sessions} onResume={() => {}} onDismiss={() => {}} />);

    expect(screen.getByText('Naprawa importu')).toBeTruthy();
    expect(screen.getByText('carimporter')).toBeTruthy();
    expect(screen.getByText('Panel EN')).toBeTruthy();
  });

  it('resumes on the primary button', () => {
    const onResume = vi.fn();
    render(<RestoreSessionsDialog sessions={sessions} onResume={onResume} onDismiss={() => {}} />);

    fireEvent.click(screen.getByText('Wznów wszystkie'));

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('names the primary button after the single session it resumes', () => {
    render(<RestoreSessionsDialog sessions={[sessions[0]]} onResume={() => {}} onDismiss={() => {}} />);

    expect(screen.getByText('Wznów')).toBeTruthy();
    expect(screen.queryByText('Wznów wszystkie')).toBeNull();
  });

  it('declines on the secondary button', () => {
    const onDismiss = vi.fn();
    render(<RestoreSessionsDialog sessions={sessions} onResume={() => {}} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('Nie teraz'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('declines on Escape without resuming', () => {
    const onResume = vi.fn();
    const onDismiss = vi.fn();
    render(<RestoreSessionsDialog sessions={sessions} onResume={onResume} onDismiss={onDismiss} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });
});
