import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { selectSortedProjects } from '../../store/projectsSlice';
import { filterProjects, clampIndex } from '../../lib/projectLauncher';
import { matchesShortcut } from '../../lib/shortcuts';
import { getProjectColor } from '../../lib/projectColors';
import { Icon } from '../shared/Icon';

export function ProjectLauncher() {
  const projects = useStore(useShallow(selectSortedProjects));
  const openNewSession = useStore(s => s.openNewSessionTab);
  const openNewTerminal = useStore(s => s.openNewTerminalTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, 'openProjectLauncher', useStore.getState().shortcutOverrides)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(o => !o);
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    inputRef.current?.focus();
  }, [open]);

  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [index, query]);

  if (!open) return null;

  const list = filterProjects(projects, query);
  const selected = list[index];
  const close = () => setOpen(false);

  const launch = (projectId: number, terminal: boolean) => {
    if (terminal) openNewTerminal(projectId);
    else openNewSession(projectId);
    close();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onMouseDown={close}
    >
      <div
        className="w-[460px] max-w-[90vw] max-h-[60vh] flex flex-col rounded-md border border-border bg-bg-elev shadow-xl overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Icon name="search" className="w-[13px] h-[13px] text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault(); e.stopPropagation();
                setIndex(i => clampIndex(i + 1, list.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault(); e.stopPropagation();
                setIndex(i => clampIndex(i - 1, list.length));
              } else if (e.key === 'Enter') {
                e.preventDefault(); e.stopPropagation();
                if (selected) launch(selected.id, e.ctrlKey || e.metaKey);
              } else if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                close();
              }
            }}
            placeholder="Szukaj projektu…"
            className="bg-transparent outline-none text-[13px] text-fg flex-1 placeholder:text-muted"
          />
        </div>
        <div className="overflow-y-auto scroll-thin py-1">
          {list.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted">— brak —</div>
          )}
          {list.map((p, i) => {
            const color = getProjectColor(p);
            const isSelected = i === index;
            return (
              <div
                key={p.id}
                ref={isSelected ? selectedRef : undefined}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={e => { e.stopPropagation(); launch(p.id, false); }}
                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none ${isSelected ? 'text-fg' : 'text-muted'}`}
                style={isSelected ? { backgroundColor: `${color}33` } : undefined}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-[12.5px] truncate">{p.name}</span>
                <span className="text-[11px] text-muted truncate ml-1">{p.path}</span>
              </div>
            );
          })}
        </div>
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-muted">
          Enter — nowa sesja · Ctrl+Enter — terminal · Esc — zamknij
        </div>
      </div>
    </div>
  );
}
