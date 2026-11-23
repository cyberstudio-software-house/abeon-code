import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatClock } from '../../lib/formatClock';
import {
  failureSummary,
  imageCarriesBuildNumber,
  isOpenTracking,
  shortCommit,
  shownBlocker,
  singleLineForTerminal,
  stageWord,
  trackingLabel,
  trackingTone,
  visibleViews,
  type DeployTone,
} from '../../lib/deployStatus';
import type { Blocker, Tracking, TrackingView } from '../../types';
import type { Tab } from '../../store/tabsSlice';
import { selectPaneOfTab } from '../../store/panesSlice';
import { Icon } from '../shared/Icon';
import { openPipeline } from './openPipeline';

type SessionTab = Extract<Tab, { kind: 'session' }>;

const TONE_DOT: Record<DeployTone, string> = {
  running: 'bg-accent activity-pulse',
  attention: 'bg-accent',
  problem: 'bg-danger',
  done: 'bg-success',
  muted: 'bg-muted',
};

function timeRange(start: number, end: number | null, ongoing: boolean): string {
  if (end !== null) return `${formatClock(start)} – ${formatClock(end)}`;
  return `${formatClock(start)} – ${ongoing ? 'trwa' : '—'}`;
}

function stageLines(tracking: Tracking): string[] {
  const open = isOpenTracking(tracking);
  const buildEnd = tracking.buildFinishedAt ?? (open ? null : tracking.finishedAt);
  const lines = [`Budowanie: ${timeRange(tracking.startedAt, buildEnd, open)}`];
  if (tracking.buildFinishedAt !== null) {
    lines.push(`Wdrażanie: ${timeRange(tracking.buildFinishedAt, open ? null : tracking.finishedAt, open)}`);
  }
  return lines;
}

function blockerText(blocker: Blocker): string {
  if (blocker.type === 'clusterUnreachable') {
    return 'Nie mogę połączyć się z klastrem. Sprawdź VPN, będę próbować dalej.';
  }
  return `Narzędzie ${blocker.tool}: ${blocker.reason}`;
}

function SendToSession({ summary, projectId, onClose }: { summary: string; projectId: number; onClose: () => void }) {
  const sessions = useStore(useShallow(s => s.tabs.filter(
    (tab): tab is SessionTab => tab.kind === 'session' && tab.projectId === projectId && tab.mode === 'terminal' && !!tab.ptyId,
  )));
  const activeAgentPtyId = useStore(s => s.activeAgentPtyId);
  const [picked, setPicked] = useState<string | null>(null);

  const chosenPtyId = sessions.some(tab => tab.ptyId === picked)
    ? picked
    : sessions.find(tab => tab.ptyId === activeAgentPtyId)?.ptyId ?? sessions[0]?.ptyId ?? null;

  const send = async () => {
    const tab = sessions.find(candidate => candidate.ptyId === chosenPtyId);
    if (!tab?.ptyId) return;
    const text = singleLineForTerminal(summary);
    try {
      await tauri.ptyWrite(tab.ptyId, btoa(unescape(encodeURIComponent(text))));
    } catch {
      toast.error('Nie udało się wysłać podsumowania do sesji');
      return;
    }
    const state = useStore.getState();
    const paneId = selectPaneOfTab(state, tab.id);
    if (paneId) state.setPaneActiveTab(paneId, tab.id);
    else state.setActive(tab.id);
    onClose();
  };

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Sesja"
        className="field flex-1 min-w-0"
        disabled={sessions.length === 0}
        value={chosenPtyId ?? ''}
        onChange={event => setPicked(event.target.value)}
      >
        {sessions.map(tab => <option key={tab.id} value={tab.ptyId}>{tab.title}</option>)}
      </select>
      <button
        type="button"
        className="btn-secondary shrink-0"
        disabled={chosenPtyId === null}
        title={chosenPtyId === null ? 'Brak otwartej sesji agenta w tym projekcie' : 'Wstawi podsumowanie do pola wpisywania, bez wysyłania'}
        onClick={() => void send()}
      >
        <Icon name="terminal" className="w-3 h-3" strokeWidth={2} />
        Wyślij do sesji
      </button>
    </div>
  );
}

function TrackingBlock({ view, projectId, onClose }: { view: TrackingView; projectId: number; onClose: () => void }) {
  const retryTracking = useStore(s => s.retryTracking);
  const dismissTracking = useStore(s => s.dismissTracking);
  const { tracking } = view;
  const open = isOpenTracking(tracking);
  const blocker = shownBlocker(tracking);
  const tone = trackingTone(tracking);
  const summary = tracking.state === 'failed' ? failureSummary(tracking) : null;

  const run = (action: () => Promise<void>, message: string) => {
    action().catch(() => toast.error(message));
  };

  return (
    <section className="rounded-lg border border-border-subtle bg-bg-elev-2 p-3 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 min-w-0 text-[13px]">
        <span aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[tone]}`} />
        <span className="font-medium text-fg-strong truncate">{view.repoLabel}</span>
        <span className="font-mono text-[11.5px] text-label">{shortCommit(tracking.commit)}</span>
        <span className="text-[11.5px] text-label truncate">{tracking.branch}</span>
        <span className="ml-auto shrink-0 text-[12px] font-medium text-fg-secondary">{trackingLabel(tracking)}</span>
      </div>

      <ul className="flex flex-col gap-0.5 text-[12px] text-fg-secondary">
        {stageLines(tracking).map(line => <li key={line}>{line}</li>)}
      </ul>

      {imageCarriesBuildNumber(tracking) && (
        <p className="text-[12px] text-success">{`Obraz zawiera numer builda ${tracking.buildNumber}`}</p>
      )}

      {open && blocker && <p className="text-[12px] text-danger">{blockerText(blocker)}</p>}

      {tracking.failure && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[12px] text-danger">{`Niepowodzenie na etapie ${stageWord(tracking.failure.stage)}: ${tracking.failure.reason}`}</p>
          {tracking.failure.logExcerpt && (
            <pre className="max-h-56 overflow-auto rounded-md bg-console p-2 font-mono text-[11px] leading-[1.5] text-fg-secondary whitespace-pre-wrap break-words">{tracking.failure.logExcerpt}</pre>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {tracking.runUrl && (
          <button type="button" className="btn-secondary" onClick={() => { void openPipeline(tracking.runUrl as string); }}>
            Otwórz pipeline
          </button>
        )}
        {open && blocker && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => run(() => retryTracking(tracking.id), 'Nie udało się ponowić sprawdzania')}
          >
            Spróbuj ponownie
          </button>
        )}
        {!open && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => run(() => dismissTracking(tracking.id), 'Nie udało się ukryć wdrożenia')}
          >
            Ukryj
          </button>
        )}
      </div>

      {summary && <SendToSession summary={summary} projectId={projectId} onClose={onClose} />}
    </section>
  );
}

export function DeployDetailsDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const trackings = useStore(s => s.trackings);
  const views = useMemo(() => visibleViews(trackings, projectId), [trackings, projectId]);
  const empty = views.length === 0;

  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Status wdrożenia"
        className="dialog-panel w-[560px] max-w-[92vw] max-h-[85vh] flex flex-col"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-[14px] font-semibold text-fg-strong">Status wdrożenia</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij"
            className="w-6 h-6 grid place-items-center rounded-md text-icon hover:bg-track hover:text-fg-strong"
          >
            <Icon name="close" className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto p-5">
          {views.map(view => (
            <TrackingBlock key={view.tracking.id} view={view} projectId={projectId} onClose={onClose} />
          ))}
        </div>
      </div>
    </div>
  );
}
