import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { GitFile, DiffResult } from '../../types';
import { GitFileList } from '../right/GitFileList';
import { Icon } from '../shared/Icon';

type Props = {
  projectId: number;
  repoLabel: string;
  files: GitFile[];
  initialFilePath: string;
  onClose: () => void;
};

export function DiffDialog({ projectId, repoLabel, files, initialFilePath, onClose }: Props) {
  const [activeFile, setActiveFile] = useState<string>(initialFilePath);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    tauri.gitDiffFile(projectId, repoLabel, activeFile).then(res => {
      if (cancelled) return;
      setResult(res);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, repoLabel, activeFile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const idx = files.findIndex(f => f.path === activeFile);
        if (idx === -1) return;
        const next = e.key === 'ArrowDown' ? Math.min(idx + 1, files.length - 1) : Math.max(idx - 1, 0);
        if (next !== idx) {
          e.preventDefault();
          setActiveFile(files[next].path);
        }
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [files, activeFile, onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elev border border-border w-[1400px] max-w-[95vw] h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-[12.5px] min-w-0">
            {repoLabel !== '.' && (
              <span className="text-muted">{repoLabel}</span>
            )}
            {repoLabel !== '.' && <span className="text-muted">/</span>}
            <span className="font-mono text-fg truncate">{activeFile}</span>
          </div>
          <button onClick={onClose} className="text-muted hover:text-fg transition-colors">
            <Icon name="close" className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          <aside className="w-[280px] shrink-0 border-r border-border overflow-auto">
            {repoLabel !== '.' && (
              <div className="px-3 py-2 text-[10px] text-muted font-medium uppercase tracking-wider border-b border-border">
                {repoLabel}
              </div>
            )}
            <GitFileList files={files} activeFilePath={activeFile} onSelect={setActiveFile} />
          </aside>
          <main className="flex-1 min-w-0 overflow-auto bg-bg">
            <DiffBody loading={loading} result={result} />
          </main>
        </div>
      </div>
    </div>
  );
}

function DiffBody({ loading, result }: { loading: boolean; result: DiffResult | null }) {
  if (loading || !result) return <div className="p-5 text-[12px] text-muted">Wczytywanie diffa…</div>;
  if (result.kind === 'binary') return <div className="p-5 text-[12px] text-muted">Plik binarny — diff niedostępny</div>;
  if (result.kind === 'tooLarge') {
    const mb = (result.size / (1024 * 1024)).toFixed(1);
    return <div className="p-5 text-[12px] text-muted">Plik za duży ({mb} MB) — diff pominięty</div>;
  }
  if (result.hunks.length === 0) return <div className="p-5 text-[12px] text-muted">Brak zmian tekstowych</div>;
  return (
    <div className="font-mono text-[12px] leading-[1.5]">
      {result.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="px-3 py-1 bg-bg-elev text-muted text-[10.5px] sticky top-0">
            {h.header}
          </div>
          {h.lines.map((l, li) => {
            const bg = l.kind === 'add' ? 'bg-success/10' : l.kind === 'del' ? 'bg-danger/10' : '';
            const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
            return (
              <div key={li} className={`flex ${bg}`}>
                <span className="w-10 px-1 text-right text-muted tabular-nums shrink-0">{l.oldLineno ?? ''}</span>
                <span className="w-10 px-1 text-right text-muted tabular-nums shrink-0">{l.newLineno ?? ''}</span>
                <span className="w-4 text-center text-muted shrink-0">{prefix}</span>
                <span className="whitespace-pre flex-1 min-w-0 text-fg">{l.content.replace(/\n$/, '')}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
