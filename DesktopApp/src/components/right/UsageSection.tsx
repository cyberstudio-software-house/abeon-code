import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatTokens, formatCost } from '../../lib/formatUsage';
import { IconBtn } from '../shared/IconBtn';
import type { UsageSummary } from '../../types';

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

export function UsageSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const sessionId = activeTab?.kind === 'session' ? activeTab.sessionId : null;

  const [sessionUsage, setSessionUsage] = useState<UsageSummary | null>(null);
  const [projectUsage, setProjectUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    setSessionUsage(null);
    if (projectId == null || sessionId == null) return;
    let unlisten: (() => void) | null = null;
    tauri.sessionUsage(projectId, sessionId).then(setSessionUsage).catch(() => {});
    tauri.onSessionUsage(sessionId, setSessionUsage).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [projectId, sessionId]);

  const refreshProject = () => {
    if (projectId == null) return;
    tauri.projectUsage(projectId).then(setProjectUsage).catch(() => {});
  };
  useEffect(() => {
    setProjectUsage(null);
    if (projectId == null) return;
    const fetchUsage = () => tauri.projectUsage(projectId).then(setProjectUsage).catch(() => {});
    fetchUsage();
    window.addEventListener('focus', fetchUsage);
    return () => window.removeEventListener('focus', fetchUsage);
  }, [projectId]);

  return (
    <section className="shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Zużycie</span>
        {projectId != null && (
          <IconBtn icon="refresh" label="Odśwież" tone="ghost" size="sm" onClick={refreshProject} />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <UsageLine label="Sesja" usage={sessionUsage} />
        <UsageLine label="Projekt" usage={projectUsage} />
      </div>
    </section>
  );
}
