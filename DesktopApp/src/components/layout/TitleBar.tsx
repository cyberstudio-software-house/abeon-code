import { useStore } from '../../store';
import { formatHeaderTitle } from '../../lib/windowTitle';

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

export function TitleBar() {
  const tabs = useStore(s => s.tabs);
  const activeTabTitle = useStore(s => s.tabs.find(t => t.id === s.activeTabId)?.title ?? null);
  const activeProjectName = useStore(s => {
    const tab = s.tabs.find(t => t.id === s.activeTabId);
    return tab ? (s.projects.find(p => p.id === tab.projectId)?.name ?? null) : null;
  });
  const headerTitle = formatHeaderTitle(activeTabTitle, activeProjectName);
  const activeSessions = tabs.filter(t => (t.kind === 'session' && t.mode === 'terminal') || t.kind === 'terminal').length;

  return (
    <header
      data-tauri-drag-region
      className="flex items-center h-9 bg-bg border-b border-border select-none shrink-0"
      style={{ paddingLeft: IS_MAC ? 78 : 16, paddingRight: 16 }}
    >
      <span className="font-mono text-[11px] text-muted tracking-wide truncate max-w-[40ch]">
        {headerTitle}
      </span>

      <div className="flex-1" />

      <div className="flex items-center gap-2.5 text-[11px] text-fg-secondary">
        {activeSessions > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            {activeSessions} aktywne sesje
          </span>
        )}
      </div>
    </header>
  );
}
