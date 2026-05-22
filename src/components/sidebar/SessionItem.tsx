import type { SessionMeta } from '../../types';
import { formatRelative } from '../../lib/format';

type Props = { session: SessionMeta; active?: boolean; onClick: () => void };

export function SessionItem({ session, active, onClick }: Props) {
  return (
    <li
      onClick={onClick}
      className={`px-2 py-1 rounded text-xs cursor-pointer truncate ${active ? 'bg-bg-elev-2 text-fg' : 'text-muted hover:text-fg hover:bg-bg-elev-2'}`}
      title={session.title}
    >
      <div className="truncate">{session.title}</div>
      <div className="text-[10px] opacity-70">{formatRelative(session.lastModified)}</div>
    </li>
  );
}
