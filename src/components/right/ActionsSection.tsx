import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { ActionList } from './ActionList';
import { AddActionDialog } from '../dialogs/AddActionDialog';

export function ActionsSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const projects = useStore(s => s.projects);
  const project = projectId != null ? projects.find(p => p.id === projectId) ?? null : null;
  const load = useStore(s => s.loadActions);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => { if (projectId != null) load(projectId); }, [projectId, load]);

  if (!project) return <div className="text-[12px] text-muted">— brak projektu —</div>;
  return (
    <section className="flex-1 min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Akcje</span>
        <span className="text-[10px] text-muted">z package.json</span>
      </div>
      <ActionList projectId={project.id} />
      <button
        onClick={() => setDialogOpen(true)}
        className="mt-3 text-[11.5px] text-muted hover:text-fg"
      >
        + dodaj akcję
      </button>
      {dialogOpen && (
        <AddActionDialog
          projectId={project.id} projectPath={project.path}
          onClose={() => setDialogOpen(false)}
          onAdded={() => load(project.id)}
        />
      )}
    </section>
  );
}
