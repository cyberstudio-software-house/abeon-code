import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { useStore } from '../../store';
import type { SessionHistory } from '../../types';
import { HistoryStream } from './HistoryStream';
import { SubagentHeader } from './SubagentHeader';

type Props = { projectId: number; sessionId: string; agentId: string; tabId: string };

export function SubagentView({ projectId, sessionId, agentId, tabId }: Props) {
  const [data, setData] = useState<SessionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewSubagent = useStore(s => s.viewSubagent);
  const info = useStore(useShallow(s => s.subagentsBySession[sessionId]?.find(a => a.agentId === agentId)));

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    tauri.readSubagentHistory(projectId, sessionId, agentId)
      .then(h => { if (!cancelled) setData(h); })
      .catch(e => { if (!cancelled) setError(formatTauriError(e)); });
    return () => { cancelled = true; };
  }, [projectId, sessionId, agentId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    tauri.onSubagentsChanged(sessionId, () => {
      tauri.readSubagentHistory(projectId, sessionId, agentId)
        .then(h => { if (!cancelled) { setData(h); setError(null); } })
        .catch(() => {});
    }).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [projectId, sessionId, agentId]);

  return (
    <div className="flex flex-col h-full">
      <SubagentHeader
        agentType={info?.agentType ?? 'Agent'}
        description={info?.description ?? ''}
        onBack={() => viewSubagent(tabId, null)}
      />
      {error && <div className="p-3 text-[12px] text-danger">Błąd: {error}</div>}
      {!error && !data && <div className="p-3 text-[12px] text-muted">Wczytywanie transkryptu…</div>}
      {data && <HistoryStream blocks={data.blocks} hasMore={false} />}
    </div>
  );
}
