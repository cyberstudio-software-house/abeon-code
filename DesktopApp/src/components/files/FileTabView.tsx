import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '../../store';
import { isFileDirty } from '../../store/filesSlice';
import type { Tab } from '../../store/tabsSlice';
import { fileName, isMarkdownPath } from '../../lib/fileText';
import { Markdown } from '../history/Markdown';
import { Kbd } from '../shared/Kbd';
import { CodeEditor } from './CodeEditor';

type Props = {
  tab: Extract<Tab, { kind: 'file' }>;
  visible: boolean;
  focused: boolean;
};

const SAVED_FLASH_MS = 2000;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center px-6 text-center text-[13px] text-muted">{children}</div>;
}

function DiskBar({ message, hint, children }: { message: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-bg-elev-2 px-4 py-1.5 text-[12px]">
      <span className="font-medium text-warn">{message}</span>
      {hint && <span className="text-muted">{hint}</span>}
      <span className="ml-auto flex items-center gap-2">{children}</span>
    </div>
  );
}

function ConflictDialog({ onOverwrite, onReload, onCancel }: { onOverwrite: () => void; onReload: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onCancel]);
  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" className="dialog-panel w-[420px] p-5">
        <h2 className="mb-2 text-[14px] font-semibold">Plik zmienił się na dysku</h2>
        <p className="mb-4 text-[13px] text-fg-secondary">Zapis nadpisze zmiany wprowadzone poza edytorem.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-secondary">Anuluj</button>
          <button type="button" onClick={onReload} className="btn-secondary">Wczytaj ponownie</button>
          <button type="button" onClick={onOverwrite} className="btn-danger">Nadpisz</button>
        </div>
      </div>
    </div>
  );
}

export function FileTabView({ tab, visible, focused }: Props) {
  const loadFileBuffer = useStore(state => state.loadFileBuffer);
  const editFileBuffer = useStore(state => state.editFileBuffer);
  const setFileBufferMode = useStore(state => state.setFileBufferMode);
  const saveFileBuffer = useStore(state => state.saveFileBuffer);
  const reloadFileBuffer = useStore(state => state.reloadFileBuffer);
  const keepFileBuffer = useStore(state => state.keepFileBuffer);
  const buffer = useStore(state => state.fileBuffers[tab.id]);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const saveStatus = buffer?.saveStatus;

  useEffect(() => {
    void loadFileBuffer(tab.id);
  }, [loadFileBuffer, tab.id]);

  useEffect(() => {
    if (saveStatus !== 'saved') {
      setSavedFlash(false);
      return;
    }
    setSavedFlash(true);
    const timer = setTimeout(() => setSavedFlash(false), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  const save = async () => {
    if ((await saveFileBuffer(tab.id)) === 'conflict') setConflictOpen(true);
  };

  const overwrite = () => {
    setConflictOpen(false);
    void saveFileBuffer(tab.id, { force: true });
  };

  const reload = async () => {
    setConflictOpen(false);
    if ((await reloadFileBuffer(tab.id)) === 'error') toast.error('Nie udało się wczytać pliku ponownie');
  };

  if (!buffer || buffer.status === 'loading') {
    return <CenteredMessage>Wczytywanie…</CenteredMessage>;
  }

  if (buffer.status === 'error') {
    return (
      <CenteredMessage>
        <div className="flex flex-col items-center gap-3">
          <span className="text-fg-secondary">Nie udało się otworzyć pliku</span>
          {buffer.error && <span className="max-w-[60ch] break-words text-[12px]">{buffer.error}</span>}
          <button type="button" className="btn-secondary" onClick={() => void loadFileBuffer(tab.id)}>Spróbuj ponownie</button>
        </div>
      </CenteredMessage>
    );
  }

  const { view } = buffer;

  if (view.kind === 'tooLarge') {
    return <CenteredMessage>{`Plik jest za duży, aby go otworzyć (${formatSize(view.size)})`}</CenteredMessage>;
  }
  if (view.kind === 'binary') {
    return <CenteredMessage>{`Plik binarny (${formatSize(view.size)})`}</CenteredMessage>;
  }
  if (view.kind === 'image') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-bg p-4">
        <img src={view.dataUrl} alt={fileName(buffer.path)} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  const dirty = isFileDirty(buffer);
  const isMarkdown = isMarkdownPath(buffer.path);
  const canSave = (dirty || buffer.disk === 'deleted') && buffer.saveStatus !== 'saving';

  let status: React.ReactNode = null;
  if (buffer.saveStatus === 'saving') status = <span className="text-muted">Zapisywanie…</span>;
  else if (buffer.saveStatus === 'error') status = <span className="text-danger">{buffer.saveError ?? 'Nie udało się zapisać'}</span>;
  else if (savedFlash) status = <span className="text-success">Zapisano</span>;
  else if (dirty) status = <span className="text-warn">Niezapisane zmiany</span>;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-elev">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-4 text-[12px]">
        <span className="min-w-0 truncate text-muted" title={buffer.path}>{buffer.path}</span>
        <span className="ml-auto flex items-center gap-3">
          {status}
          {isMarkdown && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setFileBufferMode(tab.id, buffer.mode === 'preview' ? 'edit' : 'preview')}
            >
              {buffer.mode === 'preview' ? 'Edytuj' : 'Podgląd'}
            </button>
          )}
          <button type="button" className="btn-primary" disabled={!canSave} onClick={() => void save()}>
            Zapisz
            <Kbd>Ctrl+S</Kbd>
          </button>
        </span>
      </div>
      {buffer.disk === 'changed' && (
        <DiskBar message="Plik zmienił się na dysku">
          <button type="button" className="btn-secondary" onClick={() => void reload()}>Wczytaj ponownie</button>
          <button type="button" className="btn-secondary" onClick={() => keepFileBuffer(tab.id)}>Zostaw moje</button>
        </DiskBar>
      )}
      {buffer.disk === 'deleted' && <DiskBar message="Plik został usunięty" hint="Zapis utworzy go ponownie." />}
      <div className="min-h-0 flex-1">
        {buffer.mode === 'preview' ? (
          <div className="h-full overflow-auto px-8 py-6">
            <div className="mx-auto max-w-[80ch] text-[14px] leading-relaxed">
              <Markdown text={buffer.content} />
            </div>
          </div>
        ) : (
          <CodeEditor
            value={buffer.content}
            path={buffer.path}
            onChange={content => editFileBuffer(tab.id, content)}
            onSave={() => void save()}
            focused={visible && focused}
          />
        )}
      </div>
      {conflictOpen && <ConflictDialog onOverwrite={overwrite} onReload={() => void reload()} onCancel={() => setConflictOpen(false)} />}
    </div>
  );
}
