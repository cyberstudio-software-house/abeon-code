import type { SessionMeta } from '../../types';
import { formatRelative } from '../../lib/format';

type Props = { session: SessionMeta; active?: boolean; onClick: () => void };

export function SessionItem({ session, active, onClick }: Props) {
  return (
    <li
      onClick={onClick}
      className={`pl-7 pr-2 py-1.5 text-[12px] cursor-pointer flex items-center gap-2 ${active ? 'bg-bg-elev text-fg' : 'text-fg hover:bg-bg-elev'}`}
      title={session.title}
    >
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${active ? 'bg-muted' : 'bg-muted'}`} />
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{session.title}</div>
        <div className="text-[10px] text-muted">{formatRelative(session.lastModified)}</div>
      </div>
    </li>
  );
}
