import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { DiffDialog } from './DiffDialog';
import { Icon } from '../shared/Icon';
import type { GitCommitDetail } from '../../types';

type Props = {
  projectId: number;
  repoLabel: string;
  hash: string;
  onClose: () => void;
};

export function CommitDiffDialog({ projectId, repoLabel, hash, onClose }: Props) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    tauri.gitCommitDetail(projectId, repoLabel, hash).then(d => {
      if (!cancelled) setDetail(d);
    }).catch(err => {
      if (!cancelled) setError(formatTauriError(err));
    });
    return () => { cancelled = true; };
  }, [projectId, repoLabel, hash]);

  const loadDiff = useCallback(
    (filePath: string) => tauri.gitDiffCommitFile(projectId, repoLabel, hash, filePath),
    [projectId, repoLabel, hash],
  );

  if (error) {
    return <Overlay onClose={onClose}><div className="text-[12px] text-danger">Błąd: {error}</div></Overlay>;
  }
  if (!detail) {
    return <Overlay onClose={onClose}><div className="text-[12px] text-muted">Wczytywanie commita…</div></Overlay>;
  }
  if (detail.files.length === 0) {
    return (
      <Overlay onClose={onClose}>
        <CommitSummary detail={detail} />
        <div className="text-[12px] text-muted mt-3">Commit nie zmienia żadnych plików</div>
      </Overlay>
    );
  }

  return (
    <DiffDialog
      repoLabel={repoLabel}
      files={detail.files}
      initialFilePath={detail.files[0].path}
      loadDiff={loadDiff}
      summary={<CommitSummary detail={detail} />}
      onClose={onClose}
    />
  );
}

function CommitSummary({ detail }: { detail: GitCommitDetail }) {
  const { commit, body } = detail;
  const [, ...rest] = body.split(/\n\s*\n/);
  const description = rest.join('\n\n').trim();
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-3 text-[11px] text-muted">
        <span className="font-mono text-fg-secondary">{commit.shortHash}</span>
        <span className="truncate">{commit.author}</span>
        <span className="shrink-0">{new Date(commit.timestamp * 1000).toLocaleString('pl-PL')}</span>
      </div>
      <div className="text-[13px] text-fg font-medium">{commit.subject}</div>
      {description && (
        <pre className="whitespace-pre-wrap font-sans text-[12px] text-fg-secondary max-h-32 overflow-auto">{description}</pre>
      )}
    </div>
  );
}

function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div
        className="bg-bg-elev border border-border w-[520px] max-w-[95vw] p-5 flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-end mb-2">
          <button onClick={onClose} className="text-muted hover:text-fg transition-colors">
            <Icon name="close" className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
