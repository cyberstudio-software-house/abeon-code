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
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-elev-2 text-xs">
      <button onClick={isRunning ? stop : start}
        className={`w-5 h-5 grid place-items-center rounded ${isRunning ? 'text-warn' : 'text-success'} hover:bg-bg`}>
        {isRunning ? '■' : '▶'}
      </button>
      <span className="flex-1 truncate" title={action.command}>{action.label}</span>
      {action.source && <span className="text-[10px] text-muted uppercase">{action.source}</span>}
    </div>
  );
}
