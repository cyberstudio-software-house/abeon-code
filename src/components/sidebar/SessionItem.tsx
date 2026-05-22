import type { SessionMeta } from '../../types';
import { formatRelative } from '../../lib/format';

type Props = { session: SessionMeta; active?: boolean; onClick: () => void };

export function SessionItem({ session, active, onClick }: Props) {
  return (
    <li
      onClick={onClick}
      className={`pr-2 py-1 text-[12px] cursor-pointer flex items-center gap-2 ${active ? 'bg-bg-elev text-fg' : 'text-fg hover:bg-bg-elev'}`}
      title={session.title}
    >
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${active ? 'bg-muted' : 'bg-muted'}`} />
      <span className="truncate font-medium text-[12px] flex-1 min-w-0">{session.title}</span>
      <span className="font-mono text-[10px] text-muted shrink-0">{formatRelative(session.lastModified)}</span>
    </li>
  );
}
