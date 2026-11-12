import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { dirtyFileTabIds } from '../../store/filesSlice';
import { UnsavedFilesDialog } from './UnsavedFilesDialog';

const SAVE_FAILED_MESSAGE = 'Nie udało się zapisać wszystkich plików.';

function UnsavedFilesPrompt({ tabIds, onResolve }: { tabIds: string[]; onResolve: (proceed: boolean) => void }) {
  const dirtyIds = useStore(useShallow(s => dirtyFileTabIds(s).filter(id => tabIds.includes(id))));
  const files = useStore(useShallow(s => dirtyIds.map(id => s.fileBuffers[id]?.path ?? id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    let saved = false;
    try {
      saved = await useStore.getState().saveDirtyFiles(dirtyIds);
    } catch {
      saved = false;
    }
    if (saved) {
      onResolve(true);
      return;
    }
    setBusy(false);
    setError(SAVE_FAILED_MESSAGE);
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

export function useUnsavedFilesPrompt(): { prompt: (tabIds: string[]) => Promise<boolean>; dialog: ReactNode } {
  const [request, setRequest] = useState<string[] | null>(null);
  const resolverRef = useRef<((proceed: boolean) => void) | null>(null);

  const prompt = useCallback((tabIds: string[]) => {
    if (resolverRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setRequest(tabIds);
    });
  }, []);

  const settle = useCallback((proceed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(proceed);
  }, []);

  const dialog = request ? <UnsavedFilesPrompt tabIds={request} onResolve={settle} /> : null;
  return { prompt, dialog };
}
