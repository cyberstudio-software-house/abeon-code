import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useStore } from '../../store';
import { selectSortedProjects } from '../../store/projectsSlice';
import { ProjectItem } from './ProjectItem';
import { SidebarFooter } from './SidebarFooter';
import { SortMenu } from './SortMenu';
import { ActiveSessionsPanel } from './ActiveSessionsPanel';
import { SupervisorEntry } from '../supervisor/SupervisorEntry';
import { Icon } from '../shared/Icon';
import { AddProjectDialog } from '../dialogs/AddProjectDialog';
import { matchesShortcut, getBinding, formatBinding } from '../../lib/shortcuts';

export function Sidebar() {
  const projects = useStore(useShallow(selectSortedProjects));
  const load = useStore(s => s.loadProjects);
  const loadActivity = useStore(s => s.loadActivity);
  const refreshActiveSessions = useStore(s => s.refreshActiveSessions);
  const supervisorEnabled = useStore(s => s.supervisorLevel !== 'off');
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchBinding = useStore(s => formatBinding(getBinding('focusSearch', s.shortcutOverrides)));

  useEffect(() => { load(); }, [load]);

  // Load activity on mount + refresh when the window regains focus.
  useEffect(() => {
    loadActivity();
    refreshActiveSessions();
    let unlisten: (() => void) | null = null;
    const win = getCurrentWebviewWindow();
    win.onFocusChanged(({ payload: focused }) => {
      if (focused) { loadActivity(); refreshActiveSessions(); }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [loadActivity, refreshActiveSessions]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (useStore.getState().settingsOpen) return;
    const overrides = useStore.getState().shortcutOverrides;
    if (matchesShortcut(e, 'focusSearch', overrides)) {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [handleKeyDown]);

  const filtered = query.trim()
    ? projects.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.path.toLowerCase().includes(query.toLowerCase())
      )
    : projects;

  return (
    <aside aria-label="Projekty i sesje" className="h-full bg-transparent p-1 pb-0 text-[13px] flex flex-col gap-3.5">
      <label className="h-[34px] shrink-0 flex items-center gap-2 pl-2.5 pr-2 rounded-[9px] bg-field border border-border text-label focus-within:border-border-strong">
        <Icon name="search" className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Szukaj projektu lub sesji"
          placeholder="Szukaj projektu lub sesji…"
          className="bg-transparent outline-none text-[12.5px] text-fg flex-1 min-w-0 placeholder:text-label"
        />
        <kbd aria-hidden="true" className="shrink-0 font-sans text-[10.5px] text-icon border border-border-strong rounded-[5px] px-[5px] py-px">{searchBinding}</kbd>
      </label>

      {supervisorEnabled && <SupervisorEntry />}

      <ActiveSessionsPanel />

      <section aria-labelledby="sidebar-projects" className="flex flex-col gap-1 min-h-0 flex-1">
        <div className="h-7 shrink-0 flex items-center gap-0.5 pl-1.5 pr-0.5">
          <h2 id="sidebar-projects" className="flex-1 m-0 text-[11px] font-medium tracking-[0.06em] uppercase text-label">Projekty</h2>
          <SortMenu />
          <button
            onClick={() => setAddOpen(true)}
            className="w-[26px] h-[26px] shrink-0 rounded-md grid place-items-center text-icon hover:bg-bg-elev-2 hover:text-fg transition-colors"
            aria-label="Dodaj projekt"
          >
            <Icon name="plus" className="w-3.5 h-3.5" strokeWidth={1.5} />
          </button>
        </div>
        {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} />}
        <ul className="flex flex-col gap-px overflow-y-auto scroll-thin flex-1 pb-3">
          {filtered.length === 0 && <li className="text-muted text-[12px] px-2.5">— pusto —</li>}
          {filtered.map(p => <ProjectItem key={p.id} project={p} />)}
        </ul>
      </section>

      <SidebarFooter />
    </aside>
  );
}
