import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { useStore } from '../../store';
import type { SessionHistory } from '../../types';
import { HistoryStream } from './HistoryStream';
import { SubagentHeader } from './SubagentHeader';

type Props = { projectId: number; sessionId: string; agentId: string; tabId: string };

export const RELOAD_DEBOUNCE_MS = 300;
const PAGE = 200;

function mergeRefresh(prev: SessionHistory | null, fresh: SessionHistory): SessionHistory {
  if (!prev || prev.blocks.length === 0 || fresh.blocks.length === 0) return fresh;
  const overlap = prev.blocks.findIndex(b => b.uuid === fresh.blocks[0].uuid);
  if (overlap < 0) return fresh;
  return {
    meta: fresh.meta,
    blocks: [...prev.blocks.slice(0, overlap), ...fresh.blocks],
    hasMoreBefore: prev.hasMoreBefore,
  };
}

export function SubagentView({ projectId, sessionId, agentId, tabId }: Props) {
  const [data, setData] = useState<SessionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dataRef = useRef<SessionHistory | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  const viewSubagent = useStore(s => s.viewSubagent);
  const info = useStore(useShallow(s => s.subagentsBySession[sessionId]?.find(a => a.agentId === agentId)));

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let queued = false;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;

    const publish = (next: SessionHistory) => {
      dataRef.current = next;
      setData(next);
    };

    const settle = () => {
      inFlight = false;
      if (queued && !cancelled) { queued = false; load(false); }
    };

    const load = (initial: boolean) => {
      if (cancelled) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      tauri.readSubagentHistory(projectId, sessionId, agentId)
        .then(h => { if (!cancelled) { publish(mergeRefresh(dataRef.current, h)); setError(null); } })
        .catch(e => { if (!cancelled && initial) setError(formatTauriError(e)); })
        .finally(settle);
    };

    const loadMore = () => {
      const current = dataRef.current;
      if (cancelled || inFlight || !current?.hasMoreBefore || current.blocks.length === 0) return;
      inFlight = true;
      tauri.readSubagentHistory(projectId, sessionId, agentId, PAGE, current.blocks[0].uuid)
        .then(older => {
          const base = dataRef.current;
          if (cancelled || !base) return;
          publish({
            meta: base.meta,
            blocks: [...older.blocks, ...base.blocks],
            hasMoreBefore: older.hasMoreBefore,
          });
        })
        .catch(() => {})
        .finally(settle);
    };
    loadMoreRef.current = loadMore;

    const scheduleReload = () => {
      if (cancelled) return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = null; load(false); }, RELOAD_DEBOUNCE_MS);
    };

    dataRef.current = null;
    setData(null);
    setError(null);
    load(true);
    tauri.onSubagentsChanged(sessionId, scheduleReload).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});

    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
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
      {data && (
        <HistoryStream
          blocks={data.blocks}
          onLoadMore={() => loadMoreRef.current()}
          hasMore={data.hasMoreBefore}
        />
      )}
    </div>
  );
}
