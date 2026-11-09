import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { NotesChangedEvent } from '../types/NotesChangedEvent';

const windowMock = vi.hoisted(() => ({ label: 'main' }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: windowMock.label }),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

import { useStore } from '../store';
import { tauri } from './tauri';
import { useNotesSync } from './useNotesSync';

const changed = (overrides: Partial<NotesChangedEvent> = {}): NotesChangedEvent => ({
  createdNoteId: null,
  external: false,
  sourceWindow: null,
  ...overrides,
});

describe('useNotesSync', () => {
  let emit: (event: NotesChangedEvent) => void;
  const unlisten = vi.fn();
  const reloadNotes = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    windowMock.label = 'main';
    unlisten.mockClear();
    reloadNotes.mockClear();
    toastMock.success.mockClear();
    useStore.setState({ reloadNotes });
    vi.spyOn(tauri, 'onNotesChanged').mockImplementation(async (cb) => {
      emit = cb;
      return unlisten;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('reloads notes on changes from another window', async () => {
    windowMock.label = 'main';
    renderHook(() => useNotesSync());
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit(changed({ sourceWindow: 'project-3' }));
    expect(reloadNotes).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('ignores its own changes', async () => {
    renderHook(() => useNotesSync());
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit(changed({ sourceWindow: 'main' }));
    expect(reloadNotes).not.toHaveBeenCalled();
  });

  it('announces a note added from outside in the main window only', async () => {
    const external = changed({ external: true, createdNoteId: 7 });

    windowMock.label = 'main';
    const main = renderHook(() => useNotesSync());
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit(external);
    expect(reloadNotes).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success).toHaveBeenCalledWith('Dodano notatkę');
    main.unmount();

    reloadNotes.mockClear();
    toastMock.success.mockClear();
    windowMock.label = 'project-3';
    renderHook(() => useNotesSync());
    await vi.waitFor(() => expect(tauri.onNotesChanged).toHaveBeenCalledTimes(2));
    emit(external);
    expect(reloadNotes).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('does not announce an external change that created no note', async () => {
    renderHook(() => useNotesSync());
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit(changed({ external: true }));
    expect(reloadNotes).toHaveBeenCalledTimes(1);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount, also when the subscription resolves late', async () => {
    const first = renderHook(() => useNotesSync());
    await vi.waitFor(() => expect(tauri.onNotesChanged).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    first.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);

    let resolveLate!: (fn: () => void) => void;
    vi.spyOn(tauri, 'onNotesChanged').mockImplementation(
      () => new Promise((resolve) => { resolveLate = resolve; }),
    );
    const second = renderHook(() => useNotesSync());
    second.unmount();
    resolveLate(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(2));
  });
});
