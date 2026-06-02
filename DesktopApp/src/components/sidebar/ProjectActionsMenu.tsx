import { useEffect } from 'react';
import { useStore } from '../../store';
import { processManager } from '../../lib/processManager';
import type { Action } from '../../types';
import type { RunningAction } from '../../store/actionsSlice';
import { actionTone } from '../../lib/actionStatus';
import { Icon } from '../shared/Icon';

const TONE_DOT: Record<string, string> = {
  idle: 'bg-transparent border border-border',
  running: 'bg-success',
  error: 'bg-danger',
  stopped: 'bg-muted',
};

function dotClass(r: RunningAction | undefined): string {
  return TONE_DOT[actionTone(r)];
}

type Props = { projectId: number; onClose: () => void };

export function ProjectActionsMenu({ projectId, onClose }: Props) {
  const actions = useStore(s => s.actionsByProject[projectId]) as Action[] | undefined;
  const running = useStore(s => s.runningActions) as Record<number, RunningAction>;
  const loadActions = useStore(s => s.loadActions);
  const upsertActionTab = useStore(s => s.upsertActionTab);
  const closeTab = useStore(s => s.closeTab);

  useEffect(() => { if (!actions) void loadActions(projectId); }, [projectId, actions, loadActions]);

  const showTab = (a: Action) => {
    const r = running[a.id];
    upsertActionTab({
      kind: 'action', id: `action:${a.id}`, projectId, actionId: a.id,
      title: a.label, status: r?.status ?? 'running',
      ...(r?.exitCode != null ? { exitCode: r.exitCode } : {}),
    });
    onClose();
  };
  const start = (a: Action) => { processManager.start(projectId, a); };
  const rerun = (a: Action) => { processManager.dismiss(a.id); processManager.start(projectId, a); };
  const clear = (a: Action) => { processManager.dismiss(a.id); closeTab(`action:${a.id}`); };

  if (!actions || actions.length === 0) {
    return <div className="px-3 py-2 text-[11.5px] text-muted">Brak akcji</div>;
  }

  return (
    <div role="menu" className="py-1">
      {actions.map(a => {
        const r = running[a.id];
        return (
          <div key={a.id} className="group flex items-center gap-2 px-3 py-1.5 text-[11.5px] hover:bg-bg-elev">
            <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotClass(r)}`} />
            <button
              onClick={() => (r ? showTab(a) : start(a))}
              title={r ? 'Pokaż output' : 'Uruchom'}
              className="flex-1 text-left truncate text-fg hover:text-accent"
            >
              {a.label}
            </button>
            {r?.status === 'running' && (
              <button onClick={() => processManager.stop(a.id)} title="Zatrzymaj" className="text-muted hover:text-warn p-0.5">
                <Icon name="stop" className="w-3 h-3" />
              </button>
            )}
            {r?.status === 'exited' && (
              <>
                <button onClick={() => rerun(a)} title="Uruchom ponownie" className="text-muted hover:text-fg p-0.5">
                  <Icon name="refresh" className="w-3 h-3" />
                </button>
                <button onClick={() => clear(a)} title="Wyczyść" className="text-muted hover:text-fg p-0.5">
                  <Icon name="close" className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
