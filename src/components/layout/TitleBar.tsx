import { useStore } from '../../store';

export function TitleBar() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeSessions = tabs.filter(t => t.kind === 'session' && t.mode === 'terminal').length;

  return (
    <header
      data-tauri-drag-region
      className="flex items-center h-9 px-4 bg-bg select-none shrink-0"
    >
      <div className="flex items-center gap-1.5 mr-4">
        <span className="w-[11px] h-[11px] rounded-full bg-[#ec6a5e]" />
        <span className="w-[11px] h-[11px] rounded-full bg-[#f4be4f]" />
        <span className="w-[11px] h-[11px] rounded-full bg-[#61c454]" />
      </div>

      <span className="text-[11px] text-muted">
        claude code · sessions
      </span>

      <div className="flex-1" />

      <div className="flex items-center gap-3 text-[11px]">
        {activeSessions > 0 && (
          <span className="text-fg-secondary">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-success mr-1 align-middle" />
            {activeSessions} aktywne sesje
          </span>
        )}
        {activeTab && (
          <span className="text-muted">
            {activeTab.title}
          </span>
        )}
      </div>
    </header>
  );
}
