import { useEffect, useMemo, useState } from 'react';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { useStore } from '../../store';
import type { HistoryViewMode } from '../../store/settingsSlice';
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
  const patchActivity = useStore(s => s.patchActivity);
  const defaultViewMode = useStore(s => s.historyViewMode);
  const [viewMode, setViewMode] = useState<HistoryViewMode>(defaultViewMode);

  useEffect(() => {
    tauri.readSessionHistory(projectId, sessionId)
      .then(setData)
      .catch(e => setError(formatTauriError(e)));
  }, [projectId, sessionId]);

  const renameTab = useStore(s => s.renameTab);

  useEffect(() => {
    let unlistenAppend: (() => void) | null = null;
    let unlistenActivity: (() => void) | null = null;
    let unlistenTitle: (() => void) | null = null;
    tauri.openSessionWatch(projectId, sessionId).catch(() => {});
    tauri.onSessionAppend(sessionId, (blocks) => {
      setData(prev => prev ? ({ ...prev, blocks: [...prev.blocks, ...blocks] }) : prev);
    }).then(fn => { unlistenAppend = fn; });
    tauri.onSessionActivity(sessionId, (activity) => {
      patchActivity(sessionId, activity);
    }).then(fn => { unlistenActivity = fn; });
    tauri.onSessionTitle(sessionId, (title) => {
      renameTab(`session:${sessionId}`, title);
      setData(prev => prev ? ({ ...prev, meta: { ...prev.meta, title } }) : prev);
    }).then(fn => { unlistenTitle = fn; });
    return () => {
      if (unlistenAppend) unlistenAppend();
      if (unlistenActivity) unlistenActivity();
      if (unlistenTitle) unlistenTitle();
      tauri.closeSessionWatch(sessionId).catch(() => {});
    };
  }, [projectId, sessionId, patchActivity, renameTab]);

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

  const storeActivity = useStore(s => {
    const items = s.sessionsByProject[projectId]?.items;
    return items?.find(i => i.id === sessionId)?.activity;
  });

  const meta = useMemo(() => {
    if (!data) return null;
    const patched = { ...data.meta };
    if (storeTitle && storeTitle !== data.meta.title) patched.title = storeTitle;
    if (storeActivity && storeActivity !== data.meta.activity) patched.activity = storeActivity;
    return patched;
  }, [data, storeTitle, storeActivity]);

  if (error) return <div className="p-6 text-danger text-[13px]">Błąd: {error}</div>;
  if (!data || !meta) return <div className="p-6 text-muted text-[13px]">Wczytywanie historii…</div>;
  return (
    <div className="h-full flex flex-col">
      <HistoryHeader meta={meta} viewMode={viewMode} onViewModeChange={setViewMode} />
      <HistoryStream
        blocks={data.blocks}
        onLoadMore={loadMore}
        hasMore={data.hasMoreBefore}
        header={<div className="px-8 py-5"><ReadOnlyPill /></div>}
        viewMode={viewMode}
      />
      <SessionFooter sessionId={sessionId} tabId={tabId} />
    </div>
  );
}
