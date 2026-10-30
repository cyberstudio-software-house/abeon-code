import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
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
    <section className="shrink-0 flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between px-1 pb-1.5">
        <h2 className="text-[11px] text-label font-medium uppercase tracking-[0.06em]">Akcje</h2>
        <span className="text-[11px] text-label">wykrywane automatycznie</span>
      </div>
      <ActionList projectId={project.id} onChanged={() => load(project.id)} />
      <button
        onClick={() => setDialogOpen(true)}
        className="self-start mt-1 h-7 flex items-center gap-1.5 pl-1.5 pr-2 rounded-[7px] text-[12.5px] text-icon hover:bg-bg-elev-2 hover:text-fg-strong transition-colors"
      >
        <Icon name="plus" className="w-[13px] h-[13px]" />
        Dodaj akcję
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
