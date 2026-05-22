import { useStore } from '../../store';

export function TabBar() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const setActive = useStore(s => s.setActive);
  const closeTab = useStore(s => s.closeTab);

  if (tabs.length === 0) return null;
  return (
    <div className="flex h-8 border-b border-border bg-bg-elev px-2 gap-1 items-end">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => setActive(t.id)}
          className={`group relative px-3 py-1 text-xs rounded-t border ${
            t.id === active
              ? 'bg-bg border-border border-b-bg text-fg'
              : 'bg-bg-elev-2 border-transparent text-muted hover:text-fg'
          }`}
        >
          <span className="mr-2">
            {t.kind === 'session' ? (t.mode === 'terminal' ? '⌘' : '◇') : '▶'}
          </span>
          <span className="truncate max-w-[160px] inline-block align-middle">{t.title}</span>
          <span
            onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
            className="ml-2 text-muted hover:text-danger opacity-0 group-hover:opacity-100"
          >×</span>
        </button>
      ))}
    </div>
  );
}
