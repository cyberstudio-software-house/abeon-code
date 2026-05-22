import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { ActionList } from './ActionList';
import { AddActionDialog } from '../dialogs/AddActionDialog';

export function ActionsSection() {
  const projects = useStore(s => s.projects);
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? projects[0]?.id ?? null;
  const project = projects.find(p => p.id === projectId) ?? null;
  const load = useStore(s => s.loadActions);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => { if (projectId != null) load(projectId); }, [projectId, load]);

  if (!project) return <div className="text-xs text-muted">— brak projektu —</div>;
  return (
    <section className="flex-1 min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="text-muted text-xs uppercase tracking-wide">Akcje · {project.name}</div>
        <button onClick={() => setDialogOpen(true)} className="text-xs text-accent hover:underline">+ Dodaj</button>
      </div>
      <ActionList projectId={project.id} />
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
