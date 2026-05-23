import { useEffect, useMemo, useState } from 'react';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import type { SessionHistory, HistoryBlock } from '../../types';
import { HistoryHeader } from './HistoryHeader';
import { HistoryStream } from './HistoryStream';
import { ReadOnlyPill } from './ReadOnlyPill';
import { SessionFooter } from './SessionFooter';

type Props = { projectId: number; sessionId: string; tabId: string };

function blockUuid(b: HistoryBlock): string {
  return b.uuid;
}

export function HistoryView({ projectId, sessionId, tabId }: Props) {
  const [data, setData] = useState<SessionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tauri.readSessionHistory(projectId, sessionId)
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [projectId, sessionId]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    tauri.openSessionWatch(projectId, sessionId).catch(() => {});
    tauri.onSessionAppend(sessionId, (blocks) => {
      setData(prev => prev ? ({ ...prev, blocks: [...prev.blocks, ...blocks] }) : prev);
    }).then(fn => { unlisten = fn; });
    return () => {
      if (unlisten) unlisten();
      tauri.closeSessionWatch(sessionId).catch(() => {});
    };
  }, [projectId, sessionId]);

  const loadMore = async () => {
    if (!data || !data.hasMoreBefore || data.blocks.length === 0) return;
    const firstUuid = blockUuid(data.blocks[0]);
    const more = await tauri.readSessionHistory(projectId, sessionId, 200, firstUuid);
    setData({
      meta: more.meta,
      blocks: [...more.blocks, ...data.blocks],
      hasMoreBefore: more.hasMoreBefore,
    });
  };

  const storeTitle = useStore(s => {
    const items = s.sessionsByProject[projectId]?.items;
    return items?.find(i => i.id === sessionId)?.title;
  });

  const meta = useMemo(() => {
    if (!data) return null;
    if (storeTitle && storeTitle !== data.meta.title) {
      return { ...data.meta, title: storeTitle };
    }
    return data.meta;
  }, [data, storeTitle]);

  if (error) return <div className="p-6 text-danger text-[13px]">Błąd: {error}</div>;
  if (!data || !meta) return <div className="p-6 text-muted text-[13px]">Wczytywanie historii…</div>;
  return (
    <div className="h-full flex flex-col">
      <HistoryHeader meta={meta} />
      <HistoryStream
        blocks={data.blocks}
        onLoadMore={loadMore}
        hasMore={data.hasMoreBefore}
        header={<div className="px-7 py-[18px]"><ReadOnlyPill /></div>}
      />
      <SessionFooter sessionId={sessionId} tabId={tabId} />
    </div>
  );
}
