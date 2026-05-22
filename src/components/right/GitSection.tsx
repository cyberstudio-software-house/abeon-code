import { useEffect } from 'react';
import { useStore } from '../../store';
import { GitFileList } from './GitFileList';
import { Icon } from '../shared/Icon';

export function GitSection() {
  const projects = useStore(s => s.projects);
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? projects[0]?.id ?? null;
  const status = useStore(s => projectId != null ? s.gitByProject[projectId] : null);
  const refresh = useStore(s => s.refreshGit);

  useEffect(() => {
    if (projectId == null) return;
    refresh(projectId);
    const onFocus = () => refresh(projectId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [projectId, refresh]);

  if (projectId == null) return <div className="text-[12px] text-muted">—</div>;
  return (
    <section className="flex-1 min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Zmiany</span>
        {status && status.isRepo && <span className="text-[10px] text-muted">{status.files.length} plików</span>}
      </div>
      {status?.branch && (
        <div className="flex items-center gap-2 bg-bg-elev px-3 py-1.5 mb-3 text-[11px]">
          <Icon name="branch" className="w-3.5 h-3.5 text-fg-secondary shrink-0" />
          <span className="text-fg font-medium">{status.branch}</span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="text-muted ml-auto">↑{status.ahead} ↓{status.behind}</span>
          )}
        </div>
      )}
      {!status && <div className="text-[12px] text-muted">Wczytywanie…</div>}
      {status && !status.isRepo && <div className="text-[12px] text-muted">Nie jest repozytorium git</div>}
      {status && status.isRepo && (
        <>
          <GitFileList files={status.files} />
          <div className="flex gap-2 mt-3">
            <button className="px-3 py-1.5 bg-bg-elev text-fg-secondary text-[11.5px] hover:text-fg">diff</button>
            <button className="px-3 py-1.5 bg-bg-elev text-fg-secondary text-[11.5px] hover:text-fg">stash</button>
            <button className="px-3 py-1.5 bg-bg-elev text-fg-secondary text-[11.5px] hover:text-fg">commit…</button>
          </div>
        </>
      )}
    </section>
  );
}
