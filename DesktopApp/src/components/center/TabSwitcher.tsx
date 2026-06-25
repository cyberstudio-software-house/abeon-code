import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { groupTabsByProject } from '../../lib/tabGrouping';
import { orderTabsByMru, wrapIndex } from '../../lib/tabSwitcher';
import { TabActivityDot } from './TabBar';
import type { Tab } from '../../store/tabsSlice';

function SwitcherIcon({ tab }: { tab: Tab }) {
  if (tab.kind === 'session') return <>{tab.mode === 'terminal' ? '›' : '◇'}</>;
  if (tab.kind === 'terminal') return <>$</>;
  if (tab.kind === 'providerPicker') return <>+</>;
  return <>▶</>;
}

export function TabSwitcher() {
  const projects = useStore(useShallow(s => s.projects));
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Tab[]>([]);
  const [index, setIndex] = useState(0);

  const openRef = useRef(open);
  const snapRef = useRef(snapshot);
  const idxRef = useRef(index);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { snapRef.current = snapshot; }, [snapshot]);
  useEffect(() => { idxRef.current = index; }, [index]);

  const commit = (id: string) => {
    useStore.getState().setActive(id);
    setOpen(false);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        if (!openRef.current) {
          const state = useStore.getState();
          if (state.tabs.length <= 1) return;
          e.preventDefault();
          e.stopPropagation();
          const ordered = orderTabsByMru(state.tabs, state.mruOrder);
          setSnapshot(ordered);
          setIndex(wrapIndex(e.shiftKey ? -1 : 1, ordered.length));
          setOpen(true);
        } else {
          e.preventDefault();
          e.stopPropagation();
          setIndex(wrapIndex(idxRef.current + (e.shiftKey ? -1 : 1), snapRef.current.length));
        }
        return;
      }
      if (!openRef.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setIndex(wrapIndex(idxRef.current + 1, snapRef.current.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setIndex(wrapIndex(idxRef.current - 1, snapRef.current.length));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' && openRef.current) {
        e.preventDefault();
        e.stopPropagation();
        const sel = snapRef.current[idxRef.current];
        if (sel) commit(sel.id);
        else setOpen(false);
      }
    };
    const onBlur = () => { if (openRef.current) setOpen(false); };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    document.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      document.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  if (!open) return null;

  const groups = groupTabsByProject(snapshot, projects);
  const selectedId = snapshot[index]?.id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="min-w-[320px] max-w-[480px] max-h-[70vh] overflow-y-auto rounded-md border border-border bg-bg-elev shadow-xl py-2"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted">Przełącz zakładkę</div>
        {groups.map(group => (
          <div key={group.projectId} className="py-1">
            <div className="px-3 py-0.5 text-[10px] font-semibold" style={{ color: group.color }}>
              {group.name}
            </div>
            {group.tabs.map(t => {
              const i = snapshot.findIndex(s => s.id === t.id);
              const selected = t.id === selectedId;
              return (
                <div
                  key={t.id}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={e => { e.stopPropagation(); commit(t.id); }}
                  className={`flex items-center px-3 py-1 text-[12px] cursor-pointer select-none ${selected ? 'text-fg' : 'text-muted'}`}
                  style={selected ? { backgroundColor: `${group.color}33` } : undefined}
                >
                  {t.kind === 'session' && <TabActivityDot tabId={t.id} sessionId={t.sessionId} />}
                  <span className="mr-2 text-muted"><SwitcherIcon tab={t} /></span>
                  <span className="truncate">{t.title}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
