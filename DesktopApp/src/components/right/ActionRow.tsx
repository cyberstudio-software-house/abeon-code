import { useState } from 'react';
import { useStore } from '../../store';
import { processManager } from '../../lib/processManager';
import type { Action } from '../../types';
import { actionTone } from '../../lib/actionStatus';
import { Icon } from '../shared/Icon';
import { Kbd } from '../shared/Kbd';
import { formatBinding } from '../../lib/shortcuts';
import { EditActionDialog } from '../dialogs/EditActionDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

type Props = { action: Action; index: number; onChanged: () => void };

const MAIN_BUTTON_BASE = 'shrink-0 w-[30px] h-[30px] rounded-lg border grid place-items-center transition-colors';

const MAIN_BUTTON_TONE: Record<string, string> = {
  idle: 'bg-bg-elev-2 border-border-raised text-fg hover:text-fg-strong',
  running: 'bg-success/[14%] border-success/30 text-success hover:text-fg-strong',
  error: 'bg-danger/[14%] border-danger/30 text-danger hover:text-fg-strong',
  stopped: 'bg-bg-elev-2 border-border-raised text-muted hover:text-fg-strong',
};

const ICON_BUTTON = 'p-1 rounded-md text-icon hover:bg-bg-elev-2 hover:text-fg-strong transition-colors';

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
      <div className="group flex items-center gap-2.5 px-1 py-1.5 rounded-lg hover:bg-bg-elev text-[13px]">
        {running ? (
          <button onClick={showOutput} title="Pokaż output"
            className={`${MAIN_BUTTON_BASE} ${MAIN_BUTTON_TONE[actionTone(running)]}`}>
            <Icon name="eye" className="w-[13px] h-[13px]" />
          </button>
        ) : (
          <button onClick={start} title="Uruchom"
            className={`${MAIN_BUTTON_BASE} ${MAIN_BUTTON_TONE.idle}`}>
            <Icon name="play" className="w-[11px] h-[11px]" />
          </button>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-fg truncate">{action.label}</span>
          {(action.source || action.workingDir || running) && (
            <span className="flex items-center gap-1 font-mono text-[11px] text-muted truncate">
              {running?.status === 'running' ? (
                <span className="text-success">działa</span>
              ) : (
                <>
                  {(action.source || action.workingDir) && (
                    <span className="truncate">
                      {action.source}{action.source && action.workingDir ? ' · ' : ''}{action.workingDir ? `${action.workingDir}/` : ''}
                    </span>
                  )}
                  {running?.status === 'exited' && (
                    <>
                      {(action.source || action.workingDir) && <span aria-hidden="true">·</span>}
                      <span>zakończone</span>
                    </>
                  )}
                </>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {running?.status === 'running' && (
            <button onClick={stop} title="Zatrzymaj" className={`${ICON_BUTTON} hover:text-warn`}>
              <Icon name="stop" className="w-3.5 h-3.5" />
            </button>
          )}
          {running?.status === 'exited' && (
            <>
              <button onClick={rerun} title="Uruchom ponownie" className={ICON_BUTTON}>
                <Icon name="refresh" className="w-3.5 h-3.5" />
              </button>
              <button onClick={clear} title="Wyczyść" className={ICON_BUTTON}>
                <Icon name="close" className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
        <div className="hidden group-hover:flex items-center gap-0.5">
          <button onClick={() => setEditing(true)} className={ICON_BUTTON} title="Edytuj">
            <Icon name="pencil" className="w-3 h-3" />
          </button>
          <button onClick={() => setConfirming(true)}
            className={`${ICON_BUTTON} hover:text-danger`} title="Usuń">
            <Icon name="trash" className="w-3 h-3" />
          </button>
        </div>
        {index < 9 && <Kbd>{formatBinding(`mod+${index + 1}`)}</Kbd>}
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
