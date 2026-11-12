import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type AppState } from '../../store';
import { dirtyFileTabIds, type FileSaveFailure } from '../../store/filesSlice';
import { UnsavedFilesDialog } from './UnsavedFilesDialog';

const SAVE_FAILED_MESSAGE = 'Nie udało się zapisać wszystkich plików.';
const CONFLICT_STEPS = 'Otwórz zakładkę pliku i wybierz „Wczytaj ponownie” albo „Zostaw moje”, a potem zapisz.';

const conflictMessage = (labels: string[]) => (labels.length === 1
  ? `Plik ${labels[0]} zmienił się na dysku. ${CONFLICT_STEPS}`
  : `Pliki ${labels.join(', ')} zmieniły się na dysku. ${CONFLICT_STEPS}`);

function fileLabels(state: Pick<AppState, 'fileBuffers' | 'projects'>, tabIds: string[]): string[] {
  const buffers = tabIds.map(id => state.fileBuffers[id]);
  const severalProjects = new Set(buffers.map(buffer => buffer?.projectId)).size > 1;
  return tabIds.map((id, index) => {
    const buffer = buffers[index];
    if (!buffer) return id;
    if (!severalProjects) return buffer.path;
    const project = state.projects.find(item => item.id === buffer.projectId);
    return `${project?.name ?? `projekt ${buffer.projectId}`}: ${buffer.path}`;
  });
}

function saveFailureMessage(failures: FileSaveFailure[], labelOf: (tabId: string) => string): string {
  const conflicts = failures.filter((failure) => failure.result === 'conflict').map((failure) => labelOf(failure.tabId));
  const messages: string[] = [];
  if (conflicts.length > 0) messages.push(conflictMessage(conflicts));
  if (conflicts.length < failures.length) messages.push(SAVE_FAILED_MESSAGE);
  return messages.join(' ');
}

function UnsavedFilesPrompt({ tabIds, onResolve }: { tabIds: string[]; onResolve: (proceed: boolean) => void }) {
  const dirtyIds = useStore(useShallow(s => dirtyFileTabIds(s).filter(id => tabIds.includes(id))));
  const files = useStore(useShallow(s => fileLabels(s, dirtyIds)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const listed = dirtyIds;
    const labels = new Map(listed.map((id, index) => [id, files[index]]));
    let failures: FileSaveFailure[] | null;
    try {
      failures = await useStore.getState().saveDirtyFiles(listed);
    } catch {
      failures = null;
    }
    if (failures?.length === 0) {
      onResolve(true);
      return;
    }
    setBusy(false);
    setError(failures ? saveFailureMessage(failures, (tabId) => labels.get(tabId) ?? tabId) : SAVE_FAILED_MESSAGE);
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
