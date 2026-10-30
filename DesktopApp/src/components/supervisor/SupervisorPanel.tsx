import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { formatRelative } from '../../lib/format';
import { TerminalView } from '../terminal/TerminalView';
import { Icon } from '../shared/Icon';
import type { ApprovalView, DecisionEntry, EscalationChannel, EscalationView } from '../../types';

type View = 'conversation' | 'pending' | 'log';

const TRUST_HINT =
  'Jeśli agent pyta o zaufanie do folderu, wybierz „Yes, I trust this folder” strzałką i zatwierdź Enterem — domyślna opcja zamyka agenta.';

const KIND_LABEL: Record<string, string> = {
  answered: 'Odpowiedź',
  relayed: 'Przekazano',
  escalated: 'Eskalacja',
  guard_blocked: 'Zablokowane',
  approved: 'Zatwierdzone',
  rejected: 'Odrzucone',
  session_opened: 'Otwarto sesję',
  released_to_user: 'Oddano użytkownikowi',
};

const AGE_REFRESH_MS = 30_000;

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });

function useAgeRefresh() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(tick => tick + 1), AGE_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);
}

function RowHeader({ label, createdAt, channel }: { label: string; createdAt: number; channel: EscalationChannel }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <span className="truncate">{label}</span>
      {channel === 'discord' && <DiscordBadge />}
      <span className="shrink-0 tabular-nums" title={formatTime(createdAt)}>{formatRelative(createdAt)}</span>
    </div>
  );
}

const reportFailure = (message: string) => (error: unknown) => {
  toast.error(`${message}: ${formatTauriError(error)}`);
};

function DiscordBadge() {
  return <span className="shrink-0 px-1.5 rounded bg-bg-elev-2 text-fg-secondary text-[10px]">Discord</span>;
}

const buttonClass = 'px-2.5 py-1 border border-border text-[12px] text-fg-secondary hover:text-fg rounded-md';
const primaryButtonClass = 'px-2.5 py-1 bg-accent text-accent-fg text-[12px] rounded-md';

export function SupervisorPanel() {
  const snapshot = useStore(s => s.supervisor);
  const close = useStore(s => s.closeSupervisorPanel);
  const [view, setView] = useState<View>('conversation');
  const discordEnabled = useStore(s => s.supervisorDiscordEnabled);
  const pending = (snapshot?.approvals.length ?? 0) + (snapshot?.escalations.length ?? 0);

  const tabs: Array<{ id: View; label: string; count?: number }> = [
    { id: 'conversation', label: 'Rozmowa' },
    { id: 'pending', label: 'Do decyzji', count: pending },
    { id: 'log', label: 'Dziennik' },
  ];

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-border px-3 h-10 shrink-0">
        <div role="tablist" className="flex items-center gap-1">
          {tabs.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={view === t.id}
              onClick={() => setView(t.id)}
              className={`px-2.5 py-1 rounded-md text-[12.5px] flex items-center gap-1.5 ${
                view === t.id ? 'bg-bg-elev-2 text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              {t.label}
              {t.count ? (
                <span className="min-w-4 px-1 rounded-full bg-accent text-accent-fg text-[10px] leading-4 text-center font-mono tabular-nums">
                  {t.count}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {discordEnabled && (
            <span className={`text-[11px] ${snapshot?.discordActive ? 'text-fg-secondary' : 'text-muted'}`}>
              {snapshot?.discordActive ? 'Discord połączony' : 'Discord nieaktywny'}
            </span>
          )}
          <button onClick={close} aria-label="Zamknij panel" className="text-muted hover:text-fg p-1">
            <Icon name="close" className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'conversation' && <ConversationView />}
        {view === 'pending' && <PendingView />}
        {view === 'log' && <LogView />}
      </div>
    </div>
  );
}

function ConversationView() {
  const snapshot = useStore(s => s.supervisor);

  if (!snapshot?.running) {
    return (
      <div className="h-full grid place-items-center">
        <div className="text-center space-y-3">
          <div className="text-[13px] text-fg-secondary">Agent nie działa</div>
          <button onClick={() => { void tauri.supervisorRestart().catch(reportFailure('Nie udało się uruchomić agenta ponownie')); }} className={primaryButtonClass}>
            Uruchom ponownie
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {!snapshot.ready && (
        <div className="shrink-0 px-3 py-2 text-[12px] text-fg bg-warn/20 border-b border-warn/40">
          {TRUST_HINT}
        </div>
      )}
      <div className="flex-1 min-h-0">
        {snapshot.ptyId ? (
          <TerminalView kind="supervisor" ptyId={snapshot.ptyId} />
        ) : (
          <div className="h-full grid place-items-center text-[13px] text-muted">Uruchamianie…</div>
        )}
      </div>
    </div>
  );
}

function PendingView() {
  const snapshot = useStore(s => s.supervisor);
  const openSessionTab = useStore(s => s.openSessionTab);
  const closePanel = useStore(s => s.closeSupervisorPanel);
  const approvals = snapshot?.approvals ?? [];
  const escalations = snapshot?.escalations ?? [];
  useAgeRefresh();

  if (approvals.length === 0 && escalations.length === 0) {
    return <div className="h-full grid place-items-center text-[13px] text-muted">Brak oczekujących decyzji</div>;
  }

  return (
    <ul className="h-full overflow-y-auto scroll-thin p-3 space-y-2">
      {approvals.map(a => <ApprovalRow key={a.id} approval={a} />)}
      {escalations.map(e => (
        <EscalationRow
          key={e.id}
          escalation={e}
          onOpen={e.projectId == null ? undefined : () => {
            openSessionTab(e.projectId!, e.sessionId, e.label);
            closePanel();
          }}
        />
      ))}
    </ul>
  );
}

function ApprovalRow({ approval }: { approval: ApprovalView }) {
  return (
    <li className="border border-border bg-bg-elev rounded-md p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <RowHeader label={approval.label} createdAt={approval.createdAt} channel={approval.channel} />
          <div className="text-[13px] font-medium text-fg break-words">{approval.action}</div>
          <pre className="text-[11.5px] font-mono text-fg-secondary whitespace-pre-wrap break-all">{approval.detail}</pre>
          <div className="text-[11px] text-muted">
            Kod: <span className="font-mono text-fg">{approval.code}</span>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => { void tauri.supervisorResolveApproval(approval.id, true).catch(reportFailure('Nie udało się zapisać decyzji')); }} className={primaryButtonClass}>
            Zatwierdź
          </button>
          <button onClick={() => { void tauri.supervisorResolveApproval(approval.id, false).catch(reportFailure('Nie udało się zapisać decyzji')); }} className={buttonClass}>
            Odrzuć
          </button>
        </div>
      </div>
    </li>
  );
}

function EscalationRow({ escalation, onOpen }: { escalation: EscalationView; onOpen?: () => void }) {
  return (
    <li className="border border-border bg-bg-elev rounded-md p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <RowHeader label={escalation.label} createdAt={escalation.createdAt} channel={escalation.channel} />
          <div className="text-[13px] text-fg break-words">{escalation.summary}</div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={onOpen} disabled={!onOpen} className={`${primaryButtonClass} disabled:opacity-50`}>Przejdź do sesji</button>
          <button onClick={() => { void tauri.supervisorDismissEscalation(escalation.id).catch(reportFailure('Nie udało się zapisać decyzji')); }} className={buttonClass}>
            Odrzuć
          </button>
        </div>
      </div>
    </li>
  );
}

function LogView() {
  const snapshot = useStore(s => s.supervisor);
  const [entries, setEntries] = useState<DecisionEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    tauri.supervisorListDecisions(200)
      .then(list => { if (!cancelled) { setEntries(list); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [snapshot]);

  if (failed && !entries) {
    return <div className="h-full grid place-items-center text-[13px] text-danger">Nie udało się wczytać dziennika</div>;
  }
  if (!entries) {
    return <div className="h-full grid place-items-center text-[13px] text-muted">Wczytywanie…</div>;
  }
  if (entries.length === 0) {
    return <div className="h-full grid place-items-center text-[13px] text-muted">Dziennik jest pusty</div>;
  }

  return (
    <ul className="h-full overflow-y-auto scroll-thin p-3 space-y-1.5">
      {entries.map(entry => (
        <li key={entry.id} className="border border-border bg-bg-elev rounded-md px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="font-mono">{formatTime(entry.createdAt)}</span>
            <span className="px-1.5 rounded bg-bg-elev-2 text-fg-secondary">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
          </div>
          <div className="mt-1 text-[12.5px] text-fg line-clamp-2 break-words" title={entry.question}>{entry.question}</div>
          <div className="mt-0.5 text-[12px] text-fg-secondary break-words">{entry.decision}</div>
        </li>
      ))}
    </ul>
  );
}
