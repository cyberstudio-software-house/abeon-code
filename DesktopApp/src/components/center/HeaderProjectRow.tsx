import { useMemo } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { groupTabsByProject, pickProjectTab } from '../../lib/tabGrouping';
import { usePaneTabs } from './PaneBar';
import { useTabBarActions } from './useTabBarActions';

export function HeaderProjectRow() {
  const focusedPaneId = useStore(s => s.focusedPaneId);
  const { tabs, selectedProjectId } = usePaneTabs(focusedPaneId);
  const mruOrder = useStore(useShallow(s => s.mruOrder));
  const projects = useStore(useShallow(s => s.projects));
  const setPaneActiveTab = useStore(s => s.setPaneActiveTab);

  const bar = useTabBarActions(tabs, undefined, { closeShortcut: false });

  const groups = useMemo(() => groupTabsByProject(tabs, projects), [tabs, projects]);

  const selectProject = (projectId: number) => {
    const target = pickProjectTab(tabs, mruOrder, projectId);
    if (target) setPaneActiveTab(focusedPaneId, target);
  };

  return (
    <>
      <nav
        aria-label="Otwarte projekty"
        data-tauri-drag-region
        onWheel={(e) => {
          const el = e.currentTarget;
          if (e.deltaY !== 0) { el.scrollLeft += e.deltaY; e.preventDefault(); }
        }}
        className="flex-1 min-w-0 h-full flex items-center gap-0.5 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
      >
        {groups.map(group => {
          const selected = group.projectId === selectedProjectId;
          return (
            <button
              key={group.projectId}
              data-project-tab-id={group.projectId}
              aria-current={selected ? 'page' : undefined}
              onClick={() => selectProject(group.projectId)}
              onContextMenu={(e) => bar.showGroupMenu(e, group.projectId)}
              className={`h-[30px] shrink-0 flex items-center gap-2 px-2.5 rounded-lg border text-[12.5px] whitespace-nowrap select-none ${
                selected
                  ? 'bg-bg-elev-2 border-border-raised text-fg-strong'
                  : 'border-transparent text-icon hover:text-fg'
              }`}
            >
              <span aria-hidden className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: group.color }} />
              <span className="truncate max-w-[180px]">{group.name}</span>
              <span className={`font-mono text-[11px] ${selected ? 'text-icon' : 'text-label'}`}>{group.tabs.length}</span>
            </button>
          );
        })}
      </nav>
      {bar.overlays}
    </>
  );
}
