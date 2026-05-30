import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { GitFileList } from './GitFileList';
import { GitRepoGroup } from './GitRepoGroup';
import { DiffDialog } from '../dialogs/DiffDialog';
import { Icon } from '../shared/Icon';
import { IconBtn } from '../shared/IconBtn';
import type { GitFile } from '../../types';

type DiffTarget = { repoLabel: string; filePath: string; files: GitFile[] };

export function GitSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const status = useStore(s => projectId != null ? s.gitByProject[projectId] : null);
  const refresh = useStore(s => s.refreshGit);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (projectId == null) return;
    refresh(projectId);
    const onFocus = () => refresh(projectId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [projectId, refresh]);

  if (projectId == null) return <div className="text-[12px] text-muted">—</div>;

  const totalFiles = status?.repos.reduce((n, r) => n + r.files.length, 0) ?? 0;
  const repos = status?.repos ?? [];

  return (
    <section className="flex-1 min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Zmiany</span>
          {status && status.isRepo && (
            <IconBtn
              icon="refresh"
              label="Odśwież"
              tone="ghost"
              size="sm"
              loading={refreshing}
              onClick={() => {
                setRefreshing(true);
                refresh(projectId!).finally(() => setRefreshing(false));
              }}
            />
          )}
        </div>
        {status && status.isRepo && <span className="text-[10px] text-muted">{totalFiles} plików</span>}
      </div>

      {!status && <div className="text-[12px] text-muted">Wczytywanie…</div>}
      {status && !status.isRepo && <div className="text-[12px] text-muted">Nie jest repozytorium git</div>}

      {repos.length === 1 && (
        <>
          {repos[0].branch && (
            <div className="flex items-center gap-2 bg-bg-elev px-3 py-1.5 mb-3 text-[11px]">
              <Icon name="branch" className="w-3.5 h-3.5 text-fg-secondary shrink-0" />
              <span className="text-fg font-medium">{repos[0].branch}</span>
              {(repos[0].ahead > 0 || repos[0].behind > 0) && (
                <span className="text-muted ml-auto">↑{repos[0].ahead} ↓{repos[0].behind}</span>
              )}
            </div>
          )}
          <GitFileList
            files={repos[0].files}
            onSelect={fp => setDiffTarget({ repoLabel: repos[0].label, filePath: fp, files: repos[0].files })}
          />
        </>
      )}

      {repos.length >= 2 && repos.map(repo => (
        <GitRepoGroup
          key={repo.label}
          repo={repo}
          collapsed={!!collapsed[repo.label]}
          onToggle={() => setCollapsed(c => ({ ...c, [repo.label]: !c[repo.label] }))}
          onSelectFile={fp => setDiffTarget({ repoLabel: repo.label, filePath: fp, files: repo.files })}
        />
      ))}

      {diffTarget && projectId != null && (
        <DiffDialog
          projectId={projectId}
          repoLabel={diffTarget.repoLabel}
          files={diffTarget.files}
          initialFilePath={diffTarget.filePath}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </section>
  );
}
