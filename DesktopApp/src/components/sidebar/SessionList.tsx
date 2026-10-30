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

  if (!state) return <div className="text-[12px] text-label py-1">Wczytywanie…</div>;
  if (state.items.length === 0) return <div className="text-[12px] text-label py-1">Brak sesji</div>;

  return (
    <ul className="flex flex-col gap-px mt-1">
      {state.items.map(s => (
        <SessionItem key={s.id} session={s} onClick={() => openTab(projectId, s.id, s.title, s.provider)} />
      ))}
      {state.hasMore && (
        <li>
          <button onClick={() => loadMore(projectId)}
            className="text-[11.5px] text-label hover:text-fg-strong py-1">
            Załaduj starsze…
          </button>
        </li>
      )}
    </ul>
  );
}
