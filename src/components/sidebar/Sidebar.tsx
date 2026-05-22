import { useEffect } from 'react';
import { useStore } from '../../store';
import { AddProjectButton } from './AddProjectButton';
import { ProjectItem } from './ProjectItem';
import { ThemeSwitcher } from '../layout/ThemeSwitcher';

export function Sidebar() {
  const projects = useStore(s => s.projects);
  const load = useStore(s => s.loadProjects);
  useEffect(() => { load(); }, [load]);

  return (
    <aside className="h-full bg-bg-elev border-r border-border p-3 text-sm flex flex-col">
      <div className="text-muted text-xs uppercase tracking-wide">Projekty</div>
      <ul className="mt-2 space-y-0.5 overflow-auto flex-1">
        {projects.length === 0 && <li className="text-muted">— pusto —</li>}
        {projects.map(p => <ProjectItem key={p.id} project={p} />)}
      </ul>
      <AddProjectButton />
      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
        <span className="text-[10px] text-muted uppercase">Motyw</span>
        <ThemeSwitcher />
      </div>
    </aside>
  );
}
