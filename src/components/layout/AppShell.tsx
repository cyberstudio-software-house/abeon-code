import { useCallback, useEffect, useRef } from 'react';
import { Sidebar } from '../sidebar/Sidebar';
import { CenterPanel } from '../center/CenterPanel';
import { RightPanel } from '../right/RightPanel';
import { TitleBar } from './TitleBar';
import { useStore } from '../../store';

const LEFT_MIN = 200;
const LEFT_MAX = 420;
const RIGHT_MIN = 220;
const RIGHT_MAX = 480;

type DragHandleProps = {
  onDrag: (deltaX: number) => void;
  ariaLabel: string;
};

function DragHandle({ onDrag, ariaLabel }: DragHandleProps) {
  const startX = useRef<number | null>(null);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const detach = useCallback(() => {
    if (handlersRef.current) {
      window.removeEventListener('mousemove', handlersRef.current.move);
      window.removeEventListener('mouseup', handlersRef.current.up);
      handlersRef.current = null;
    }
    startX.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    const move = (ev: MouseEvent) => {
      if (startX.current === null) return;
      const delta = ev.clientX - startX.current;
      startX.current = ev.clientX;
      onDragRef.current(delta);
    };
    const up = () => detach();
    handlersRef.current = { move, up };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onMouseDown={onMouseDown}
      className="w-px cursor-col-resize bg-border hover:bg-accent transition-colors flex-shrink-0"
    />
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function AppShell() {
  const leftWidth = useStore(s => s.leftWidth);
  const rightWidth = useStore(s => s.rightWidth);
  const setLeftWidth = useStore(s => s.setLeftWidth);
  const setRightWidth = useStore(s => s.setRightWidth);
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const hasActiveProject = tabs.some(t => t.id === activeTabId);
  const startActivityPolling = useStore(s => s.startActivityPolling);
  const stopActivityPolling = useStore(s => s.stopActivityPolling);

  useEffect(() => {
    startActivityPolling();
    return () => stopActivityPolling();
  }, [startActivityPolling, stopActivityPolling]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;

      const state = useStore.getState();
      const activeTab = state.tabs.find(t => t.id === state.activeTabId);
      const projectId = activeTab?.projectId;

      if ((e.key === 'n' || e.key === 'N') && projectId != null) {
        e.preventDefault();
        e.stopPropagation();
        state.openNewSessionTab(projectId);
        return;
      }

      if (e.key >= '1' && e.key <= '9' && projectId != null) {
        const action = (state.actionsByProject[projectId] ?? [])[Number(e.key) - 1];
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        state.upsertActionTab({
          kind: 'action', id: `action:${action.id}`, projectId: action.projectId,
          actionId: action.id, title: action.label, status: 'running',
        });
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  const onLeftDrag = useCallback(
    (delta: number) => setLeftWidth(clamp(leftWidth + delta, LEFT_MIN, LEFT_MAX)),
    [leftWidth, setLeftWidth],
  );
  const onRightDrag = useCallback(
    (delta: number) => setRightWidth(clamp(rightWidth - delta, RIGHT_MIN, RIGHT_MAX)),
    [rightWidth, setRightWidth],
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-bg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <div style={{ width: leftWidth }} className="h-full flex-shrink-0">
          <Sidebar />
        </div>
        <DragHandle onDrag={onLeftDrag} ariaLabel="Resize sidebar" />
        <div className="flex-1 h-full min-w-0">
          <CenterPanel />
        </div>
        {hasActiveProject && (
          <>
            <DragHandle onDrag={onRightDrag} ariaLabel="Resize right panel" />
            <div style={{ width: rightWidth }} className="h-full flex-shrink-0">
              <RightPanel />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
