import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatTokens, formatCost, formatDuration } from '../../lib/formatUsage';
import { TabButton } from '../shared/TabButton';
import type { ProviderLimits, RateLimitWindow, UsageSummary } from '../../types';

type UsageTab = 'usage' | 'limits';

const TAB_CLASS = 'px-1.5 py-0.5 text-[10px] uppercase tracking-wider';

function totalTokens(u: UsageSummary): number {
  return u.tokens.input + u.tokens.output + u.tokens.cacheWrite + u.tokens.cacheRead;
}

function UsageLine({ label, usage }: { label: string; usage: UsageSummary | null }) {
  if (!usage) {
    return (
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="text-muted">—</span>
      </div>
    );
  }
  const unknown = usage.unknownModels.length > 0;
  const tooltip = usage.byModel
    .map(m => `${m.model}: ${formatTokens(m.tokens.input + m.tokens.output + m.tokens.cacheWrite + m.tokens.cacheRead)} tok · ${formatCost(m.costUsd)}`)
    .join('\n')
    + (unknown ? `\n(brak ceny: ${usage.unknownModels.join(', ')})` : '');
  return (
    <div className="flex items-center justify-between text-[12px]" title={tooltip}>
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-fg-secondary tabular-nums">{formatTokens(totalTokens(usage))} tok</span>
        <span className="text-fg font-medium tabular-nums">~{formatCost(usage.costUsd)}</span>
        {unknown && <span className="text-warn" title="Część modeli bez ceny">*</span>}
      </span>
    </div>
  );
}

function DurationLine({ label, ms }: { label: string; ms: number | null | undefined }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-muted">{label}</span>
      <span className={ms != null ? 'text-fg-secondary tabular-nums' : 'text-muted'}>
        {ms != null ? formatDuration(ms) : '—'}
      </span>
    </div>
  );
}

function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 60) return '1 godzina';
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60} godzin`;
  return `${windowMinutes} min`;
}

function formatReset(resetsAt: number | null): string {
  if (resetsAt == null) return 'Reset: —';
  return `Reset: ${new Date(resetsAt * 1000).toLocaleString('pl-PL', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function limitTone(usedPercent: number): string {
  if (usedPercent >= 90) return 'bg-danger';
  if (usedPercent >= 75) return 'bg-warn';
  return 'bg-accent';
}

function LimitLine({ label, limit }: { label: string; limit: RateLimitWindow | null }) {
  if (!limit) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted">{label}</span>
          <span className="text-muted">—</span>
        </div>
        <div className="h-1 bg-bg-elev-2" />
      </div>
    );
  }

  const percent = Math.round(limit.usedPercent);
  const width = Math.min(100, Math.max(0, limit.usedPercent));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-fg-secondary">{label}</span>
        <span className="text-fg font-medium tabular-nums">{percent}%</span>
      </div>
      <div
        className="h-1 bg-bg-elev-2 overflow-hidden"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
      >
        <div className={`h-full ${limitTone(limit.usedPercent)}`} style={{ width: `${width}%` }} />
      </div>
      <span className="text-[10px] text-muted tabular-nums">{formatReset(limit.resetsAt)}</span>
    </div>
  );
}

export function UsageSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const sessionId = activeTab?.kind === 'session' ? activeTab.sessionId : null;
  const provider = activeTab?.kind === 'session' ? (activeTab.provider ?? 'claude') : null;
  const supportsUsage = provider !== 'opencode';

  const [tab, setTab] = useState<UsageTab>('limits');
  const [sessionUsage, setSessionUsage] = useState<UsageSummary | null>(null);
  const [limits, setLimits] = useState<ProviderLimits | null | undefined>(undefined);

  useEffect(() => {
    setSessionUsage(null);
    if (!supportsUsage || tab !== 'usage' || projectId == null || sessionId == null) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    tauri.sessionUsage(projectId, sessionId).then(setSessionUsage).catch(() => {});
    tauri.onSessionUsage(sessionId, setSessionUsage).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [projectId, sessionId, supportsUsage, tab]);

  useEffect(() => {
    setLimits(undefined);
    if (!supportsUsage || tab !== 'limits' || provider == null) {
      setLimits(null);
      return;
    }
    let disposed = false;
    const load = () => {
      tauri.providerLimits(provider)
        .then(value => { if (!disposed) setLimits(value); })
        .catch(() => { if (!disposed) setLimits(null); });
    };
    load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [provider, supportsUsage, tab]);

  const hasLimits = limits?.shortWindow != null || limits?.weekly != null;

  return (
    <section className="shrink-0">
      <div className="flex items-center gap-1.5 mb-3" role="tablist">
        <TabButton active={tab === 'usage'} onClick={() => setTab('usage')} className={TAB_CLASS}>Zużycie</TabButton>
        <TabButton active={tab === 'limits'} onClick={() => setTab('limits')} className={TAB_CLASS}>Limity</TabButton>
      </div>

      {tab === 'usage' ? (
        supportsUsage ? (
          <div className="flex flex-col gap-1">
            <UsageLine label="Sesja" usage={sessionUsage} />
            <DurationLine label="Czas sesji" ms={sessionUsage?.durationMs} />
            <DurationLine label="Czas aktywny" ms={sessionUsage?.activeMs} />
          </div>
        ) : (
          <div className="text-[12px] text-muted">Brak danych o zużyciu dla OpenCode</div>
        )
      ) : !supportsUsage ? (
        <div className="text-[12px] text-muted">Brak danych o limitach dla OpenCode</div>
      ) : limits === undefined ? (
        <div className="text-[12px] text-muted">Wczytywanie…</div>
      ) : hasLimits ? (
        <div className="flex flex-col gap-3">
          <LimitLine
            label={limits.shortWindow ? formatWindowLabel(limits.shortWindow.windowMinutes) : 'Krótkie okno'}
            limit={limits.shortWindow}
          />
          <LimitLine label="Tydzień" limit={limits.weekly} />
        </div>
      ) : (
        <div className="text-[12px] text-muted">Brak danych o limitach</div>
      )}
    </section>
  );
}
