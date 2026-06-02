import { useState } from 'react';
import { useStore } from '../../store';
import { processManager } from '../../lib/processManager';
import type { Action } from '../../types';
import { actionTone } from '../../lib/actionStatus';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';
import { EditActionDialog } from '../dialogs/EditActionDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

type Props = { action: Action; index: number; onChanged: () => void };

const TONE_TEXT: Record<string, string> = {
  idle: 'text-fg-secondary',
  running: 'text-success',
  error: 'text-danger',
  stopped: 'text-muted',
};

export function ActionRow({ action, index, onChanged }: Props) {
  const tabId = `action:${action.id}`;
  const running = useStore(s => s.runningActions[action.id]);
  const upsertActionTab = useStore(s => s.upsertActionTab);
  const closeTab = useStore(s => s.closeTab);
  const removeAction = useStore(s => s.removeAction);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const start = () => { processManager.start(action.projectId, action); };
  const showOutput = () => {
    upsertActionTab({
      kind: 'action', id: tabId, projectId: action.projectId,
      actionId: action.id, title: action.label, status: running?.status ?? 'running',
      ...(running?.exitCode != null ? { exitCode: running.exitCode } : {}),
    });
  };
  const stop = () => { processManager.stop(action.id); };
  const rerun = () => { processManager.dismiss(action.id); processManager.start(action.projectId, action); };
  const clear = () => { processManager.dismiss(action.id); closeTab(tabId); };

  const handleDelete = async () => {
    await removeAction(action.id);
    setConfirming(false);
  };

  return (
    <>
      <div className="group flex items-center gap-3 px-2 py-2 hover:bg-bg-elev text-[12px]">
        {running ? (
          <button onClick={showOutput} title="Pokaż output"
            className={`shrink-0 ${TONE_TEXT[actionTone(running)]} hover:text-fg`}>
            <Icon name="eye" className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button onClick={start} title="Uruchom"
            className="shrink-0 text-fg-secondary hover:text-fg">
            <Icon name="play" className="w-3.5 h-3.5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-fg truncate">{action.label}</div>
          {(action.source || action.workingDir) && (
            <div className="text-[10px] text-muted">
              {action.source}{action.workingDir ? ` · ${action.workingDir}/` : ''}
              {running?.status === 'running' ? ' · w tle' : running?.status === 'exited' ? ' · zakończone' : ''}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {running?.status === 'running' && (
            <button onClick={stop} title="Zatrzymaj" className="text-muted hover:text-warn p-0.5">
              <Icon name="stop" className="w-3.5 h-3.5" />
            </button>
          )}
          {running?.status === 'exited' && (
            <>
              <button onClick={rerun} title="Uruchom ponownie" className="text-muted hover:text-fg p-0.5">
                <Icon name="refresh" className="w-3.5 h-3.5" />
              </button>
              <button onClick={clear} title="Wyczyść" className="text-muted hover:text-fg p-0.5">
                <Icon name="close" className="w-3.5 h-3.5" />
              </button>
            </>
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
