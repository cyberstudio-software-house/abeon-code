import { useEffect } from 'react';
import { useStore } from '../../store';
import { GitFileList } from './GitFileList';

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

  if (projectId == null) return <div className="text-xs text-muted">—</div>;
  return (
    <section className="flex-1 min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="text-muted text-xs uppercase tracking-wide">
          Git {status?.branch ? `· ${status.branch}` : ''}
        </div>
        <button onClick={() => refresh(projectId)} className="text-xs text-muted hover:text-fg">⟳</button>
      </div>
      {!status && <div className="text-xs text-muted">Wczytywanie…</div>}
      {status && !status.isRepo && <div className="text-xs text-muted">Nie jest repozytorium git</div>}
      {status && status.isRepo && (
        <>
          {(status.ahead > 0 || status.behind > 0) && (
            <div className="text-[11px] text-muted mb-1">↑{status.ahead} ↓{status.behind}</div>
          )}
          <GitFileList files={status.files} />
        </>
      )}
    </section>
  );
}
