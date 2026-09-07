import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import { formatRelative } from '../../lib/format';
import { formatTauriError } from '../../lib/errors';
import { CommitDiffDialog } from '../dialogs/CommitDiffDialog';
import type { GitBranch, GitCommit, GitRepo } from '../../types';

const PAGE_SIZE = 50;
const SELECT_CLASS =
  'bg-bg-elev-2 border border-border rounded text-fg text-[11px] px-1.5 py-0.5 min-w-0 flex-1 cursor-pointer focus:outline-none focus:border-accent';

type Props = {
  projectId: number;
  repos: GitRepo[];
  reloadToken: number;
};

function pickBranch(branches: GitBranch[], current: string | null): string | null {
  if (current && branches.some(b => b.name === current)) return current;
  return branches.find(b => b.isHead)?.name ?? branches[0]?.name ?? null;
}

export function GitHistory({ projectId, repos, reloadToken }: Props) {
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const repoLabel = repos.some(r => r.label === selectedRepo) ? selectedRepo! : (repos[0]?.label ?? '.');

  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openHash, setOpenHash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    tauri.gitBranches(projectId, repoLabel).then(list => {
      if (cancelled) return;
      setBranches(list);
      setBranch(current => pickBranch(list, current));
    }).catch(err => {
      if (cancelled) return;
      setError(formatTauriError(err));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, repoLabel, reloadToken]);

  useEffect(() => {
    if (branch == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    tauri.gitLog(projectId, repoLabel, branch, 0, PAGE_SIZE).then(page => {
      if (cancelled) return;
      setCommits(page);
      setHasMore(page.length === PAGE_SIZE);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setError(formatTauriError(err));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, repoLabel, branch, reloadToken]);

  const loadMore = () => {
    if (branch == null || loadingMore) return;
    setLoadingMore(true);
    tauri.gitLog(projectId, repoLabel, branch, commits.length, PAGE_SIZE).then(page => {
      setCommits(prev => [...prev, ...page]);
      setHasMore(page.length === PAGE_SIZE);
    }).catch(err => {
      setError(formatTauriError(err));
    }).finally(() => setLoadingMore(false));
  };

  const local = branches.filter(b => !b.isRemote);
  const remote = branches.filter(b => b.isRemote);

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-1.5 mb-3">
        {repos.length >= 2 && (
          <select
            aria-label="Repozytorium"
            value={repoLabel}
            onChange={e => { setSelectedRepo(e.target.value); setBranch(null); setCommits([]); }}
            className={SELECT_CLASS}
          >
            {repos.map(r => <option key={r.label} value={r.label}>{r.label}</option>)}
          </select>
        )}
        <select
          aria-label="Gałąź"
          value={branch ?? ''}
          onChange={e => setBranch(e.target.value)}
          disabled={branches.length === 0}
          className={SELECT_CLASS}
        >
          {local.length > 0 && (
            <optgroup label="Lokalne">
              {local.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </optgroup>
          )}
          {remote.length > 0 && (
            <optgroup label="Zdalne">
              {remote.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </optgroup>
          )}
        </select>
      </div>

      {error && <div className="text-[12px] text-danger px-2">Błąd: {error}</div>}
      {!error && loading && <div className="text-[12px] text-muted px-2">Wczytywanie…</div>}
      {!error && !loading && commits.length === 0 && <div className="text-[12px] text-muted px-2">Brak commitów</div>}

      {!error && !loading && commits.length > 0 && (
        <div className="min-h-0 overflow-auto">
          {commits.map(c => (
            <button
              key={c.hash}
              type="button"
              onClick={() => setOpenHash(c.hash)}
              className="w-full flex flex-col gap-0.5 px-2 py-[5px] border-b border-border/50 hover:bg-bg-elev transition-colors text-left"
            >
              <span className="w-full text-[11.5px] text-fg truncate">{c.subject}</span>
              <span className="w-full flex items-center gap-2 text-[10px] text-muted">
                <span className="font-mono text-fg-secondary shrink-0">{c.shortHash}</span>
                <span className="truncate">{c.author}</span>
                <span className="ml-auto shrink-0">{formatRelative(c.timestamp * 1000)}</span>
              </span>
            </button>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full py-2 text-[11px] text-accent hover:underline disabled:opacity-50"
            >
              {loadingMore ? 'Wczytywanie…' : 'Załaduj więcej'}
            </button>
          )}
        </div>
      )}

      {openHash && (
        <CommitDiffDialog
          projectId={projectId}
          repoLabel={repoLabel}
          hash={openHash}
          onClose={() => setOpenHash(null)}
        />
      )}
    </div>
  );
}
