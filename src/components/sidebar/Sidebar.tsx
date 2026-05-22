import { useEffect } from 'react';
import { useStore } from '../../store';
import { AddProjectButton } from './AddProjectButton';
import { ProjectItem } from './ProjectItem';
import { SidebarFooter } from './SidebarFooter';
import { Icon } from '../shared/Icon';

export function Sidebar() {
  const projects = useStore(s => s.projects);
  const load = useStore(s => s.loadProjects);
  useEffect(() => { load(); }, [load]);

  return (
    <aside className="h-full bg-bg p-4 text-[13px] flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Projekty</span>
      </div>

      <div className="flex items-center bg-bg-elev px-3 py-1.5 text-[12px]">
        <Icon name="search" className="w-3.5 h-3.5 text-muted mr-2 shrink-0" />
        <span className="text-muted text-[12px]">Szukaj projektu lub sesji…</span>
        <span className="ml-auto text-[10px] text-muted">⌘K</span>
      </div>

      <ul className="space-y-1 overflow-auto flex-1">
        {projects.length === 0 && <li className="text-muted text-[12px]">— pusto —</li>}
        {projects.map(p => <ProjectItem key={p.id} project={p} />)}
      </ul>

      <AddProjectButton />

      <SidebarFooter />
    </aside>
  );
}
