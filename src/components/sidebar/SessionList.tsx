import { useEffect } from 'react';
import { useStore } from '../../store';
import { SessionItem } from './SessionItem';

type Props = { projectId: number };

export function SessionList({ projectId }: Props) {
  const state = useStore(s => s.sessionsByProject[projectId]);
  const load = useStore(s => s.loadInitialSessions);
  const loadMore = useStore(s => s.loadMoreSessions);
  const openTab = useStore(s => s.openSessionTab);

  useEffect(() => { if (!state) load(projectId); }, [projectId, state, load]);

  if (!state) return <div className="text-xs text-muted pl-4 py-1">Wczytywanie…</div>;
  if (state.items.length === 0) return <div className="text-xs text-muted pl-4 py-1">Brak sesji</div>;

  return (
    <ul className="pl-4 space-y-0.5 mt-1">
      {state.items.map(s => (
        <SessionItem key={s.id} session={s} onClick={() => openTab(projectId, s.id, s.title)} />
      ))}
      {state.hasMore && (
        <li>
          <button onClick={() => loadMore(projectId)}
            className="text-[11px] text-muted hover:text-fg pl-2 py-1">
            Załaduj starsze…
          </button>
        </li>
      )}
    </ul>
  );
}
