import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { tauri } from '../../lib/tauri';
import type { Project } from '../../types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { NotesWorkspace } from './NotesWorkspace';

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

type ProjectState =
  | { status: 'loading' | 'missing' | 'error' }
  | { status: 'ready'; project: Project };

export function NotesShell({ projectId }: { projectId: number }) {
  const [projectState, setProjectState] = useState<ProjectState>({ status: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);

  useEffect(() => {
    let cancelled = false;
    setProjectState({ status: 'loading' });
    void tauri.listProjects().then(projects => {
      if (cancelled) return;
      const project = projects.find(candidate => candidate.id === projectId);
      setProjectState(project ? { status: 'ready', project } : { status: 'missing' });
    }).catch(() => {
      if (!cancelled) setProjectState({ status: 'error' });
    });
    return () => { cancelled = true; };
  }, [projectId, loadAttempt]);

  const title = projectState.status === 'ready' ? `Notatki — ${projectState.project.name}` : 'Notatki';

  useEffect(() => {
    void tauri.setWindowTitle(title).catch(console.error);
  }, [title]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebviewWindow().onCloseRequested(event => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      setConfirmingClose(true);
    }).then(stopListening => {
      if (cancelled) stopListening();
      else unlisten = stopListening;
    }).catch(console.error);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg">
      <header
        data-tauri-drag-region
        className="flex items-center h-9 bg-bg border-b border-border select-none shrink-0"
        style={{ paddingLeft: IS_MAC ? 78 : 16, paddingRight: 16 }}
      >
        <span className="font-mono text-[11px] text-muted tracking-wide truncate max-w-[40ch]">
          {title}
        </span>
      </header>
      <main className="flex flex-col flex-1 min-h-0 min-w-0">
        {projectState.status === 'ready' ? (
          <NotesWorkspace projectId={projectState.project.id} onDirtyChange={onDirtyChange} />
        ) : (
          <div className="flex flex-col flex-1 items-center justify-center gap-3 p-6 text-[13px] text-fg-secondary">
            {projectState.status === 'loading' && <p role="status">Wczytywanie projektu…</p>}
            {projectState.status === 'missing' && <p role="alert">Nie znaleziono projektu dla tego okna notatek.</p>}
            {projectState.status === 'error' && (
              <>
                <p role="alert">Nie udało się wczytać projektu dla okna notatek.</p>
                <button
                  className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg"
                  onClick={() => setLoadAttempt(attempt => attempt + 1)}
                >
                  Spróbuj ponownie
                </button>
              </>
            )}
          </div>
        )}
      </main>
      {confirmingClose && (
        <ConfirmDialog
          title="Odrzucić niezapisane zmiany?"
          message="Zamknięcie okna spowoduje utratę niezapisanych zmian."
          confirmLabel="Odrzuć i zamknij"
          onCancel={() => setConfirmingClose(false)}
          onConfirm={() => void getCurrentWebviewWindow().destroy()}
        />
      )}
    </div>
  );
}
