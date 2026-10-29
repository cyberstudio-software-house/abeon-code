import { useStore } from '../../store';
import { toast } from 'sonner';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';

const STARTING_HINT = 'Uruchamianie… — otwórz panel i zaakceptuj zaufanie do folderu, jeśli pyta';

const DOT = {
  ready: { className: 'bg-success', title: 'Działa' },
  starting: { className: 'bg-warn', title: STARTING_HINT },
  stopped: { className: 'bg-danger', title: 'Nie działa' },
} as const;

export function SupervisorEntry() {
  const snapshot = useStore(s => s.supervisor);
  const openPanel = useStore(s => s.openSupervisorPanel);

  const state = snapshot?.ready ? 'ready' : snapshot?.running ? 'starting' : 'stopped';
  const dot = DOT[state];
  const pending = (snapshot?.approvals.length ?? 0) + (snapshot?.escalations.length ?? 0);
  const away = snapshot?.away ?? false;

  return (
    <div className="mt-3 flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-elev border border-border rounded-md">
      <button
        onClick={openPanel}
        className="flex-1 min-w-0 flex items-center gap-2 text-left text-[12.5px] font-medium text-fg"
      >
        <span
          data-testid="supervisor-dot"
          data-state={state}
          title={dot.title}
          className={`w-2 h-2 rounded-full shrink-0 ${dot.className}`}
        />
        <span className="truncate">Agent sterujący</span>
        {pending > 0 && (
          <span
            data-testid="supervisor-badge"
            className="shrink-0 min-w-4 px-1 rounded-full bg-accent text-white text-[10px] leading-4 text-center font-mono tabular-nums"
          >
            {pending}
          </span>
        )}
      </button>
      <button
        onClick={() => {
          tauri.supervisorSetAway(!away).catch((error: unknown) => {
            toast.error(`Nie udało się zmienić statusu „Nie ma mnie”: ${formatTauriError(error)}`);
          });
        }}
        aria-pressed={away}
        className={`shrink-0 px-1.5 py-0.5 rounded border text-[10.5px] transition-colors ${
          away ? 'bg-accent text-white border-accent' : 'border-border text-muted hover:text-fg'
        }`}
      >
        Nie ma mnie
      </button>
    </div>
  );
}
