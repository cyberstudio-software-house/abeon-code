import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { tauri } from '../../lib/tauri';
import { formatTauriError } from '../../lib/errors';
import { useStore } from '../../store';
import type { HistoryViewMode } from '../../store/settingsSlice';
import type { SessionHistory, HistoryBlock, Provider } from '../../types';
import { HistoryHeader } from './HistoryHeader';
import { HistoryStream } from './HistoryStream';
import { HistorySearchBar } from './HistorySearchBar';
import { useHistorySearch } from './useHistorySearch';
import { ReadOnlyPill } from './ReadOnlyPill';
import { SessionFooter } from './SessionFooter';

type Props = { projectId: number; sessionId: string; tabId: string; provider?: Provider };

const COMMUNICATION_KINDS = new Set<HistoryBlock['kind']>(['userText', 'assistantText']);

function blockUuid(b: HistoryBlock): string {
  return b.uuid;
}

export function HistoryView({ projectId, sessionId, tabId, provider = 'claude' }: Props) {
  const [data, setData] = useState<SessionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patchActivity = useStore(s => s.patchActivity);
  const defaultViewMode = useStore(s => s.historyViewMode);
  const [viewMode, setViewMode] = useState<HistoryViewMode>(defaultViewMode);
  const activeTabId = useStore(s => s.activeTabId);

  const [searchOpen, setSearchOpen] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  useEffect(() => {
    tauri.readSessionHistory(projectId, sessionId, provider)
      .then(setData)
      .catch(e => setError(formatTauriError(e)));
  }, [projectId, sessionId, provider]);

  const renameTab = useStore(s => s.renameTab);

  useEffect(() => {
    let unlistenAppend: (() => void) | null = null;
    let unlistenActivity: (() => void) | null = null;
    let unlistenTitle: (() => void) | null = null;
    tauri.openSessionWatch(projectId, sessionId, provider).catch(() => {});
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
  }, [projectId, sessionId, provider, patchActivity, renameTab]);

  const loadMore = async () => {
    if (!data || !data.hasMoreBefore || data.blocks.length === 0) return;
    const firstUuid = blockUuid(data.blocks[0]);
    const more = await tauri.readSessionHistory(projectId, sessionId, provider, 200, firstUuid);
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

  const filtered = useMemo(() => {
    const blocks = data?.blocks ?? [];
    return viewMode === 'communication'
      ? blocks.filter(b => COMMUNICATION_KINDS.has(b.kind))
      : blocks;
  }, [data, viewMode]);

  const search = useHistorySearch(filtered);
  const matchedSet = useMemo(() => new Set(search.matches), [search.matches]);

  useEffect(() => {
    if (search.activeBlockIndex >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: search.activeBlockIndex, align: 'center', behavior: 'smooth' });
    }
  }, [search.activeBlockIndex]);

  const closeSearch = useCallback(() => { setSearchOpen(false); search.reset(); }, [search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tabId !== activeTabId) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey, { capture: true });
    return () => document.removeEventListener('keydown', onKey, { capture: true });
  }, [tabId, activeTabId]);

  if (error) return <div className="p-6 text-danger text-[13px]">Błąd: {error}</div>;
  if (!data || !meta) return <div className="p-6 text-muted text-[13px]">Wczytywanie historii…</div>;
  return (
    <div className="h-full flex flex-col">
      <HistoryHeader
        meta={meta}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        provider={provider}
        onToggleSearch={() => setSearchOpen(o => !o)}
      />
      {searchOpen && (
        <HistorySearchBar
          query={search.query}
          onQueryChange={search.setQuery}
          count={search.count}
          activeIndex={search.activeIndex}
          onNext={search.next}
          onPrev={search.prev}
          onClose={closeSearch}
          hasOlderUnloaded={data.hasMoreBefore}
        />
      )}
      <HistoryStream
        blocks={filtered}
        onLoadMore={loadMore}
        hasMore={data.hasMoreBefore}
        header={<div className="px-8 py-5"><ReadOnlyPill /></div>}
        matchedIndices={matchedSet}
        activeBlockIndex={search.activeBlockIndex}
        virtuosoRef={virtuosoRef}
      />
      <SessionFooter sessionId={sessionId} tabId={tabId} />
    </div>
  );
}
