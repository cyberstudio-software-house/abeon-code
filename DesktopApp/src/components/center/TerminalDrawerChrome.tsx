import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../../store';
import {
  clampDrawerSize,
  cssLen,
  DRAWER_MIN_SPLIT_HEIGHT,
  DRAWER_MIN_SPLIT_WIDTH,
  lenRectStyle,
  resolveLen,
  type LenRect,
} from '../../lib/drawerGeometry';
import type { CollapsedDrawer, VisibleDrawer } from '../../lib/paneLayers';
import { formatBinding, getBinding, type ShortcutId } from '../../lib/shortcuts';
import { Icon } from '../shared/Icon';
import { IconBtn } from '../shared/IconBtn';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { SplitResizers } from './PaneResizers';

const drawerMinPx = (dir: 'row' | 'col') => (dir === 'row' ? DRAWER_MIN_SPLIT_WIDTH : DRAWER_MIN_SPLIT_HEIGHT);

function DrawerDivider({ content, header, containerRef }: {
  content: LenRect;
  header: LenRect;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const setDrawerDragSize = useStore(s => s.setDrawerDragSize);
  const setTerminalDrawerSize = useStore(s => s.setTerminalDrawerSize);
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null);

  const finish = useCallback(() => {
    if (!handlersRef.current) return;
    window.removeEventListener('mousemove', handlersRef.current.move);
    window.removeEventListener('mouseup', handlersRef.current.up);
    handlersRef.current = null;
    const size = useStore.getState().drawerDragSize;
    if (size !== null) setTerminalDrawerSize(size);
    setDrawerDragSize(null);
  }, [setDrawerDragSize, setTerminalDrawerSize]);

  useEffect(() => finish, [finish]);

  const onMouseDown = (e: React.MouseEvent) => {
    finish();
    e.preventDefault();
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const contentPx = resolveLen(content.height, box.height);
    if (contentPx <= 0) return;
    const startY = e.clientY;
    const startSize = useStore.getState().terminalDrawerSize;
    const move = (ev: MouseEvent) =>
      setDrawerDragSize(clampDrawerSize(startSize - (ev.clientY - startY) / contentPx, contentPx));
    handlersRef.current = { move, up: finish };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      data-drawer-divider
      onMouseDown={onMouseDown}
      className="absolute z-30 h-[5px] -translate-y-1/2 cursor-row-resize bg-border hover:bg-accent transition-colors"
      style={{ left: cssLen(header.left), top: cssLen(header.top), width: cssLen(header.width) }}
    />
  );
}

export function TerminalDrawerChrome({ entry, containerRef }: {
  entry: VisibleDrawer;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const { ownerTabId, paneId, rects, drawer } = entry;
  const focusedPaneId = useStore(s => s.focusedPaneId);
  const overrides = useStore(s => s.shortcutOverrides);
  const focusPane = useStore(s => s.focusPane);
  const focusDrawerTerminal = useStore(s => s.focusDrawerTerminal);
  const splitDrawerTerminal = useStore(s => s.splitDrawerTerminal);
  const detachDrawerTerminal = useStore(s => s.detachDrawerTerminal);
  const requestCloseDrawerTerminal = useStore(s => s.requestCloseDrawerTerminal);
  const hideTerminalDrawer = useStore(s => s.hideTerminalDrawer);
  const resizeDrawerSplit = useStore(s => s.resizeDrawerSplit);
  const onResize = useCallback(
    (splitId: string, sizes: number[]) => resizeDrawerSplit(ownerTabId, splitId, sizes),
    [ownerTabId, resizeDrawerSplit],
  );
  const hint = (id: ShortcutId) => formatBinding(getBinding(id, overrides));
  const focusedRect = rects.terminals.get(drawer.focusedTerminalId);

  return (
    <>
      <DrawerDivider content={rects.content} header={rects.header} containerRef={containerRef} />
      <div
        data-drawer-header={ownerTabId}
        onMouseDownCapture={e => {
          e.preventDefault();
          focusPane(paneId);
          focusDrawerTerminal(ownerTabId, drawer.focusedTerminalId);
        }}
        className="absolute z-20 flex items-center justify-between gap-2 border-t border-border bg-bg px-2"
        style={lenRectStyle(rects.header)}
      >
        <span className="text-[11px] text-muted select-none">Terminal</span>
        <div className="flex items-center gap-0.5">
          <IconBtn tone="ghost" size="sm" icon="splitRow" label={`Podziel w prawo (${hint('splitTerminalRight')})`} onClick={() => splitDrawerTerminal(ownerTabId, 'row')} />
          <IconBtn tone="ghost" size="sm" icon="splitCol" label={`Podziel w dół (${hint('splitTerminalDown')})`} onClick={() => splitDrawerTerminal(ownerTabId, 'col')} />
          <IconBtn tone="ghost" size="sm" icon="toTab" label="Wydziel do zakładki" onClick={() => detachDrawerTerminal(drawer.focusedTerminalId)} />
          <IconBtn tone="ghost" size="sm" icon="close" label="Zamknij terminal" onClick={() => requestCloseDrawerTerminal(drawer.focusedTerminalId)} />
          <IconBtn tone="ghost" size="sm" icon="chevron" label="Schowaj panel" onClick={() => hideTerminalDrawer(ownerTabId)} />
        </div>
      </div>
      <SplitResizers layout={drawer.layout} containerRef={containerRef} frame={rects.body} minPx={drawerMinPx} onResize={onResize} />
      {rects.terminals.size > 1 && drawer.hasFocus && focusedPaneId === paneId && focusedRect && (
        <div
          data-drawer-focus-ring
          className="absolute z-20 pointer-events-none border border-accent"
          style={lenRectStyle(focusedRect)}
        />
      )}
    </>
  );
}

export function CollapsedDrawerBar({ entry }: { entry: CollapsedDrawer }) {
  const { ownerTabId, paneId, rect, terminalCount } = entry;
  const overrides = useStore(s => s.shortcutOverrides);
  const focusPane = useStore(s => s.focusPane);
  const showTerminalDrawer = useStore(s => s.showTerminalDrawer);
  const label = `Pokaż terminal (${formatBinding(getBinding('newTerminal', overrides))})`;

  return (
    <button
      type="button"
      data-drawer-collapsed={ownerTabId}
      aria-label={label}
      title={label}
      onClick={() => {
        focusPane(paneId);
        showTerminalDrawer(ownerTabId);
      }}
      className="absolute z-20 flex items-center justify-between gap-2 border-t border-border bg-bg px-2 text-muted cursor-pointer hover:text-fg hover:bg-bg-elev-2 transition-colors"
      style={lenRectStyle(rect)}
    >
      <span className="text-[11px] select-none">{terminalCount > 1 ? `Terminal · ${terminalCount}` : 'Terminal'}</span>
      <Icon name="chevU" />
    </button>
  );
}

export function DrawerCloseDialog() {
  const prompt = useStore(s => s.drawerClosePrompt);
  const cancel = useStore(s => s.cancelCloseDrawerTerminal);
  const close = useStore(s => s.closeDrawerTerminal);
  if (!prompt) return null;
  return (
    <ConfirmDialog
      title="Zamknąć terminal?"
      message="W tym terminalu działa powłoka. Zamknięcie zakończy ją."
      onCancel={cancel}
      onConfirm={() => close(prompt)}
    />
  );
}
