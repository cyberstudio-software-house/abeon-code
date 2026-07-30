import { useMemo } from 'react';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { computePaneRects, TAB_BAR_HEIGHT } from '../../lib/paneGeometry';
import { leaves } from '../../lib/paneTree';
import { TabBar } from './TabBar';
import { TabPanel } from './TabContent';

export function PaneLayout({ detachedProjectId }: { detachedProjectId?: number } = {}) {
  const layout = useStore(s => s.layout);
  const tabs = useStore(useShallow(s => s.tabs));
  const rects = useMemo(() => computePaneRects(layout), [layout]);
  const panes = useMemo(() => leaves(layout), [layout]);
  const ownerOf = useMemo(() => {
    const map = new Map<string, { paneId: string; active: boolean }>();
    for (const pane of panes) {
      for (const tabId of pane.tabIds) map.set(tabId, { paneId: pane.id, active: pane.activeTabId === tabId });
    }
    return map;
  }, [panes]);

  return (
    <div className="flex-1 relative overflow-hidden">
      {panes.map(pane => {
        const rect = rects.get(pane.id);
        if (!rect) return null;
        return (
          <div
            key={pane.id}
            data-pane-id={pane.id}
            className="absolute"
            style={{
              left: `${rect.left}%`,
              top: `${rect.top}%`,
              width: `${rect.width}%`,
              height: `${TAB_BAR_HEIGHT}px`,
            }}
          >
            <TabBar paneId={pane.id} detachedProjectId={detachedProjectId} />
          </div>
        );
      })}
      {/* Layers stay siblings of one container: a new DOM parent would remount TerminalView, whose cleanup kills the live PTY. */}
      {tabs.map(tab => {
        const owner = ownerOf.get(tab.id);
        const rect = owner ? rects.get(owner.paneId) : undefined;
        if (!owner || !rect) return null;
        return (
          <div
            key={tab.id}
            data-tab-layer={tab.id}
            className={`absolute ${owner.active ? '' : 'invisible pointer-events-none'}`}
            style={{
              left: `${rect.left}%`,
              top: `calc(${rect.top}% + ${TAB_BAR_HEIGHT}px)`,
              width: `${rect.width}%`,
              height: `calc(${rect.height}% - ${TAB_BAR_HEIGHT}px)`,
            }}
          >
            <TabPanel tab={tab} visible={owner.active} />
          </div>
        );
      })}
      {tabs.length === 0 && (
        <div className="absolute inset-0 grid place-items-center text-muted text-[13px]">
          {detachedProjectId != null ? 'Otwórz nową sesję przyciskiem + na pasku zakładek' : 'Wybierz sesję z lewej'}
        </div>
      )}
    </div>
  );
}
