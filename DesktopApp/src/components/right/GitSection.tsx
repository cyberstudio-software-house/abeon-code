import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { GitFileList } from './GitFileList';
import { GitHistory } from './GitHistory';
import { GitRepoGroup } from './GitRepoGroup';
import { DiffDialog } from '../dialogs/DiffDialog';
import { Icon } from '../shared/Icon';
import { IconBtn } from '../shared/IconBtn';
import { TabButton } from '../shared/TabButton';
import type { GitFile } from '../../types';

type DiffTarget = { repoLabel: string; filePath: string; files: GitFile[] };
type GitTab = 'changes' | 'history';

export function GitSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const status = useStore(s => projectId != null ? s.gitByProject[projectId] : null);
  const refresh = useStore(s => s.refreshGit);

  const [tab, setTab] = useState<GitTab>('changes');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [historyReloadToken, setHistoryReloadToken] = useState(0);

  const diffRepoLabel = diffTarget?.repoLabel ?? null;
  const loadWorkdirDiff = useCallback(
    (filePath: string) => tauri.gitDiffFile(projectId!, diffRepoLabel!, filePath),
    [projectId, diffRepoLabel],
  );

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

  const onRefresh = () => {
    if (tab === 'history') {
      setHistoryReloadToken(t => t + 1);
      return;
    }
    setRefreshing(true);
    refresh(projectId).finally(() => setRefreshing(false));
  };

  return (
    <section className="flex-1 min-h-0 overflow-auto flex flex-col gap-2.5">
      <div className="flex items-center gap-0.5 px-0.5">
        <div className="flex items-center gap-0.5" role="tablist">
          <TabButton active={tab === 'changes'} onClick={() => setTab('changes')}>Zmiany</TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>Historia</TabButton>
        </div>
        <span className="flex-1" />
        {tab === 'changes' && status && status.isRepo && (
          <span className="text-[11.5px] text-muted">{totalFiles} plików</span>
        )}
        {status && status.isRepo && (
          <IconBtn
            icon="refresh"
            label="Odśwież"
            tone="ghost"
            size="md"
            loading={refreshing}
            onClick={onRefresh}
          />
        )}
      </div>

      {!status && <div className="px-1 text-[12px] text-muted">Wczytywanie…</div>}
      {status && !status.isRepo && <div className="px-1 text-[12px] text-muted">Nie jest repozytorium git</div>}

      {tab === 'history' && status && status.isRepo && (
        <GitHistory key={projectId} projectId={projectId} repos={repos} reloadToken={historyReloadToken} />
      )}

      {tab === 'changes' && repos.length === 1 && (
        <div className="flex flex-col gap-0.5 p-2 bg-bg-elev border border-border rounded-[10px]">
          {repos[0].branch && (
            <div className="flex items-center gap-2 px-1 pt-1 pb-2 text-fg-secondary">
              <Icon name="branch" className="w-3.5 h-3.5 shrink-0" />
              <span className="font-mono text-[12.5px] text-fg">{repos[0].branch}</span>
              {(repos[0].ahead > 0 || repos[0].behind > 0) && (
                <span className="ml-auto font-mono text-[11.5px] text-icon">↑{repos[0].ahead} ↓{repos[0].behind}</span>
              )}
            </div>
          )}
          <GitFileList
            files={repos[0].files}
            onSelect={fp => setDiffTarget({ repoLabel: repos[0].label, filePath: fp, files: repos[0].files })}
          />
        </div>
      )}

      {tab === 'changes' && repos.length >= 2 && repos.map(repo => (
        <GitRepoGroup
          key={repo.label}
          repo={repo}
          collapsed={!!collapsed[repo.label]}
          onToggle={() => setCollapsed(c => ({ ...c, [repo.label]: !c[repo.label] }))}
          onSelectFile={fp => setDiffTarget({ repoLabel: repo.label, filePath: fp, files: repo.files })}
        />
      ))}

      {diffTarget && (
        <DiffDialog
          repoLabel={diffTarget.repoLabel}
          files={diffTarget.files}
          initialFilePath={diffTarget.filePath}
          loadDiff={loadWorkdirDiff}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </section>
  );
}
