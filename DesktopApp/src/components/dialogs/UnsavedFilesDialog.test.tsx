import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { UnsavedFilesDialog } from './UnsavedFilesDialog';

const files = ['src/a.ts', 'docs/readme.md'];

const renderDialog = (props: Partial<React.ComponentProps<typeof UnsavedFilesDialog>> = {}) => {
  const handlers = { onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() };
  render(<UnsavedFilesDialog files={files} {...handlers} {...props} />);
  return handlers;
};

describe('UnsavedFilesDialog', () => {
  it('shows the title and lists every file', () => {
    renderDialog();

    expect(screen.getByText('Niezapisane zmiany')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('docs/readme.md')).toBeTruthy();
  });

  it('focuses the save button when opened', () => {
    renderDialog();

    expect(document.activeElement).toBe(screen.getByText('Zapisz'));
  });

  it('fires the matching callback for each button', () => {
    const { onSave, onDiscard, onCancel } = renderDialog();

    fireEvent.click(screen.getByText('Zapisz'));
    fireEvent.click(screen.getByText('Odrzuć zmiany'));
    fireEvent.click(screen.getByText('Anuluj'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', () => {
    const { onCancel, onDiscard } = renderDialog();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('shows the error text when given one', () => {
    renderDialog({ error: 'Nie udało się zapisać wszystkich plików.' });

    expect(screen.getByText('Nie udało się zapisać wszystkich plików.')).toBeTruthy();
  });

  it('shows no error text by default', () => {
    renderDialog();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables all three buttons and ignores Escape while busy', () => {
    const { onCancel } = renderDialog({ busy: true });

    expect(screen.getByText('Zapisz').closest('button')).toBeDisabled();
    expect(screen.getByText('Odrzuć zmiany').closest('button')).toBeDisabled();
    expect(screen.getByText('Anuluj').closest('button')).toBeDisabled();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCancel).not.toHaveBeenCalled();
  });
});
