import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { dirtyFileTabIds, type FileSaveFailure } from '../../store/filesSlice';
import { UnsavedFilesDialog } from './UnsavedFilesDialog';

const SAVE_FAILED_MESSAGE = 'Nie udało się zapisać wszystkich plików.';

const conflictMessage = (paths: string[]) =>
  `Nie udało się zapisać: ${paths.join(', ')}. Plik zmienił się na dysku — otwórz zakładkę i wybierz „Nadpisz” albo „Wczytaj ponownie”.`;

function saveFailureMessage(failures: FileSaveFailure[]): string {
  const conflicts = failures.filter((failure) => failure.result === 'conflict').map((failure) => failure.path);
  const messages: string[] = [];
  if (conflicts.length > 0) messages.push(conflictMessage(conflicts));
  if (conflicts.length < failures.length) messages.push(SAVE_FAILED_MESSAGE);
  return messages.join(' ');
}

function UnsavedFilesPrompt({ tabIds, onResolve }: { tabIds: string[]; onResolve: (proceed: boolean) => void }) {
  const dirtyIds = useStore(useShallow(s => dirtyFileTabIds(s).filter(id => tabIds.includes(id))));
  const files = useStore(useShallow(s => dirtyIds.map(id => s.fileBuffers[id]?.path ?? id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    let failures: FileSaveFailure[] | null;
    try {
      failures = await useStore.getState().saveDirtyFiles(dirtyIds);
    } catch {
      failures = null;
    }
    if (failures?.length === 0) {
      onResolve(true);
      return;
    }
    setBusy(false);
    setError(failures ? saveFailureMessage(failures) : SAVE_FAILED_MESSAGE);
  };

  return (
    <UnsavedFilesDialog
      files={files}
      busy={busy}
      error={error}
      onSave={() => { void save(); }}
      onDiscard={() => onResolve(true)}
      onCancel={() => onResolve(false)}
    />
  );
}

type PromptRequest = { id: number; tabIds: string[] };
type PendingPrompt = { id: number; resolve: (proceed: boolean) => void };

export function useUnsavedFilesPrompt(): { prompt: (tabIds: string[]) => Promise<boolean>; dialog: ReactNode } {
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const lastIdRef = useRef(0);

  const prompt = useCallback((tabIds: string[]) => {
    if (pendingRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      lastIdRef.current += 1;
      const id = lastIdRef.current;
      pendingRef.current = { id, resolve };
      setRequest({ id, tabIds });
    });
  }, []);

  const settle = useCallback((id: number, proceed: boolean) => {
    const pending = pendingRef.current;
    if (pending?.id !== id) return;
    pendingRef.current = null;
    setRequest(null);
    pending.resolve(proceed);
  }, []);

  const dialog = request
    ? <UnsavedFilesPrompt key={request.id} tabIds={request.tabIds} onResolve={(proceed) => settle(request.id, proceed)} />
    : null;
  return { prompt, dialog };
}
