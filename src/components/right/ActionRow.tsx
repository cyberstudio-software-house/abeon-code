import { useState } from 'react';
import { useStore } from '../../store';
import type { Action } from '../../types';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';
import { EditActionDialog } from '../dialogs/EditActionDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

type Props = { action: Action; index: number; onChanged: () => void };

export function ActionRow({ action, index, onChanged }: Props) {
  const tabs = useStore(s => s.tabs);
  const tabId = `action:${action.id}`;
  const isRunning = tabs.some(t => t.id === tabId);
  const upsertActionTab = useStore(s => s.upsertActionTab);
  const closeTab = useStore(s => s.closeTab);
  const removeAction = useStore(s => s.removeAction);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const start = () => {
    upsertActionTab({
      kind: 'action', id: tabId, projectId: action.projectId,
      actionId: action.id, title: action.label, status: 'running',
    });
  };

  const stop = () => {
    closeTab(tabId);
  };

  const handleDelete = async () => {
    await removeAction(action.id);
    setConfirming(false);
  };

  return (
    <>
      <div className="group flex items-center gap-3 px-2 py-2 hover:bg-bg-elev text-[12px]">
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
          {(action.source || action.workingDir) && (
            <div className="text-[10px] text-muted">
              {action.source}{action.workingDir ? ` · ${action.workingDir}/` : ''}{isRunning ? ' · uruchomione' : ''}
            </div>
          )}
        </div>
        <div className="hidden group-hover:flex items-center gap-1">
          <button onClick={() => setEditing(true)}
            className="text-muted hover:text-fg p-0.5" title="Edytuj">
            <Icon name="pencil" className="w-3 h-3" />
          </button>
          <button onClick={() => setConfirming(true)}
            className="text-muted hover:text-danger p-0.5" title="Usuń">
            <Icon name="trash" className="w-3 h-3" />
          </button>
        </div>
        {index < 9 && <Kbd>⌘{index + 1}</Kbd>}
      </div>
      {editing && (
        <EditActionDialog
          action={action}
          onClose={() => setEditing(false)}
          onUpdated={onChanged}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title="Usuń akcję"
          message={`Usunąć akcję "${action.label}"?`}
          onConfirm={handleDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
