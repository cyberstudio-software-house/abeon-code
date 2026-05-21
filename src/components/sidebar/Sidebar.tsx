import { useEffect } from 'react';
import { useStore } from '../../store';
import { AddProjectButton } from './AddProjectButton';

export function Sidebar() {
  const projects = useStore(s => s.projects);
  const load = useStore(s => s.loadProjects);
  useEffect(() => { load(); }, [load]);

  return (
    <aside className="h-full bg-bg-elev border-r border-border p-3 text-sm flex flex-col">
      <div className="text-muted text-xs uppercase tracking-wide">Projekty</div>
      <ul className="mt-2 space-y-1 overflow-auto flex-1">
        {projects.length === 0 && <li className="text-muted">— pusto —</li>}
        {projects.map(p => (
          <li key={p.id} className="px-2 py-1 rounded hover:bg-bg-elev-2 cursor-pointer">
            {p.name}
          </li>
        ))}
      </ul>
      <AddProjectButton />
    </aside>
  );
}
