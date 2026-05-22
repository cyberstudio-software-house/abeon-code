import { useStore } from '../../store';
import type { Action } from '../../types';

type Props = { action: Action };

export function ActionRow({ action }: Props) {
  const tabs = useStore(s => s.tabs);
  const tabId = `action:${action.id}`;
  const isRunning = tabs.some(t => t.id === tabId);
  const upsertActionTab = useStore(s => s.upsertActionTab);
  const closeTab = useStore(s => s.closeTab);

  const start = () => {
    upsertActionTab({
      kind: 'action', id: tabId, projectId: action.projectId,
      actionId: action.id, title: action.label, status: 'running',
    });
  };

  const stop = () => {
    closeTab(tabId);
  };

  return (
    <div className="flex items-center gap-3 px-2 py-2 hover:bg-bg-elev text-[12px]">
      <button onClick={isRunning ? stop : start}
        className={`shrink-0 ${isRunning ? 'text-warn' : 'text-fg-secondary'} hover:text-fg`}>
        {isRunning ? (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" /></svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-fg truncate">{action.label}</div>
        {action.source && <div className="text-[10px] text-muted">{action.source}{isRunning ? ' · uruchomione' : ''}</div>}
      </div>
    </div>
  );
}
