import { useStore } from '../../store';
import { ActionRow } from './ActionRow';

type Props = { projectId: number };

export function ActionList({ projectId }: Props) {
  const items = useStore(s => s.actionsByProject[projectId]);
  if (!items || items.length === 0) return <div className="text-[12px] text-muted">Brak akcji</div>;
  return (
    <div className="space-y-0.5">
      {items.map((a, i) => <ActionRow key={a.id} action={a} index={i} />)}
    </div>
  );
}
