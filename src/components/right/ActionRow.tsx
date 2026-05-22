import { useStore } from '../../store';
import type { Action } from '../../types';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';

type Props = { action: Action; index: number };

export function ActionRow({ action, index }: Props) {
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
          <Icon name="stop" className="w-3.5 h-3.5" />
        ) : (
          <Icon name="play" className="w-3.5 h-3.5" />
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-fg truncate">{action.label}</div>
        {action.source && <div className="text-[10px] text-muted">{action.source}{isRunning ? ' · uruchomione' : ''}</div>}
      </div>
      {index < 9 && <Kbd>⌘{index + 1}</Kbd>}
    </div>
  );
}
