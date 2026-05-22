import { useStore } from '../../store';

export function TabContent() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const tab = tabs.find(t => t.id === active);
  if (!tab) return <div className="flex-1 grid place-items-center text-muted">Wybierz sesję z lewej</div>;
  return <div className="flex-1 p-4 text-fg text-sm">tab placeholder — {tab.id}</div>;
}
