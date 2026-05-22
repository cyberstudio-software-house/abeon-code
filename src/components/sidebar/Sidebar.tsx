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
    <aside className="h-full bg-bg p-4 text-[13px] flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Projekty</span>
      </div>

      <div className="flex items-center bg-bg-elev px-3 py-1.5 text-[12px]">
        <svg className="w-3.5 h-3.5 text-muted mr-2 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <span className="text-muted text-[12px]">Szukaj projektu lub sesji…</span>
        <span className="ml-auto text-[10px] text-muted">⌘K</span>
      </div>

      <ul className="space-y-1 overflow-auto flex-1">
        {projects.length === 0 && <li className="text-muted text-[12px]">— pusto —</li>}
        {projects.map(p => <ProjectItem key={p.id} project={p} />)}
      </ul>

      <AddProjectButton />

      <div className="pt-3 border-t border-border flex items-center justify-between">
        <span className="text-[10px] text-muted uppercase tracking-wider">Motyw</span>
        <ThemeSwitcher />
      </div>
    </aside>
  );
}
