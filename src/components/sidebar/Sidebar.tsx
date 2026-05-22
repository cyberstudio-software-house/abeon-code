import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { AddProjectButton } from './AddProjectButton';
import { ProjectItem } from './ProjectItem';
import { SidebarFooter } from './SidebarFooter';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';

export function Sidebar() {
  const projects = useStore(s => s.projects);
  const load = useStore(s => s.loadProjects);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, [load]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const filtered = query.trim()
    ? projects.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.path.toLowerCase().includes(query.toLowerCase())
      )
    : projects;

  return (
    <aside className="h-full bg-bg px-[18px] pt-[18px] pb-2.5 text-[13px] flex flex-col">
      <div className="text-[10px] tracking-[0.14em] uppercase text-muted font-medium">
        Projekty
      </div>

      <div className="mt-2.5 flex items-center gap-2 px-2.5 py-[7px] bg-bg-elev border border-border rounded-md">
        <Icon name="search" className="w-[13px] h-[13px] text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Szukaj projektu lub sesji…"
          className="bg-transparent outline-none text-[12px] text-fg flex-1 placeholder:text-muted"
        />
        <Kbd>⌘K</Kbd>
      </div>

      <ul className="mt-3 space-y-0.5 overflow-y-auto scroll-thin flex-1 px-1.5 pb-3">
        {filtered.length === 0 && <li className="text-muted text-[12px] px-2.5">— pusto —</li>}
        {filtered.map(p => <ProjectItem key={p.id} project={p} />)}
      </ul>

      <AddProjectButton />
      <SidebarFooter />
    </aside>
  );
}
