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

  if (!state) return <div className="text-[12px] text-muted py-1">Wczytywanie…</div>;
  if (state.items.length === 0) return <div className="text-[12px] text-muted py-1">Brak sesji</div>;

  return (
    <ul className="space-y-0.5 mt-1">
      {state.items.map(s => (
        <SessionItem key={s.id} session={s} onClick={() => openTab(projectId, s.id, s.title, s.provider)} />
      ))}
      {state.hasMore && (
        <li>
          <button onClick={() => loadMore(projectId)}
            className="text-[11.5px] text-muted hover:text-fg py-1">
            Załaduj starsze…
          </button>
        </li>
      )}
    </ul>
  );
}
