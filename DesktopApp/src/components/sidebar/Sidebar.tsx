import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useStore } from '../../store';
import { selectSortedProjects } from '../../store/projectsSlice';
import { ProjectItem } from './ProjectItem';
import { SidebarFooter } from './SidebarFooter';
import { SortMenu } from './SortMenu';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';
import { AddProjectDialog } from '../dialogs/AddProjectDialog';
import { matchesShortcut, getBinding, formatBinding } from '../../lib/shortcuts';

export function Sidebar() {
  const projects = useStore(useShallow(selectSortedProjects));
  const load = useStore(s => s.loadProjects);
  const loadActivity = useStore(s => s.loadActivity);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchBinding = useStore(s => formatBinding(getBinding('focusSearch', s.shortcutOverrides)));

  useEffect(() => { load(); }, [load]);

  // Load activity on mount + refresh when the window regains focus.
  useEffect(() => {
    loadActivity();
    let unlisten: (() => void) | null = null;
    const win = getCurrentWebviewWindow();
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) loadActivity();
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [loadActivity]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const overrides = useStore.getState().shortcutOverrides;
    if (matchesShortcut(e, 'focusSearch', overrides)) {
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
    <aside className="h-full bg-bg px-2.5 pt-[18px] pb-2.5 text-[13px] flex flex-col">
      <div className="flex items-center justify-between">
        <div className="text-[10px] tracking-[0.14em] uppercase text-muted font-medium">
          Projekty
        </div>
        <div className="flex items-center gap-1">
          <SortMenu />
          <button
            onClick={() => setAddOpen(true)}
            className="text-muted hover:text-fg transition-colors p-0.5"
            aria-label="Dodaj projekt"
          >
            <Icon name="plus" className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
      {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} />}

      <div className="mt-2.5 flex items-center gap-2 px-2.5 py-[7px] bg-bg-elev border border-border rounded-md">
        <Icon name="search" className="w-[13px] h-[13px] text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Szukaj projektu lub sesji…"
          className="bg-transparent outline-none text-[12px] text-fg flex-1 placeholder:text-muted"
        />
        <Kbd>{searchBinding}</Kbd>
      </div>

      <ul className="mt-3 space-y-0.5 overflow-y-auto scroll-thin flex-1 pb-3">
        {filtered.length === 0 && <li className="text-muted text-[12px] px-2.5">— pusto —</li>}
        {filtered.map(p => <ProjectItem key={p.id} project={p} />)}
      </ul>

      <SidebarFooter />
    </aside>
  );
}
