import type { SessionMeta } from '../../types';
import { IconBtn } from '../shared/IconBtn';

type Props = { meta: SessionMeta };

export function HistoryHeader({ meta }: Props) {
  return (
    <header className="px-7 pt-[18px] pb-3.5 border-b border-border bg-bg shrink-0">
      <div className="font-mono text-[10px] text-muted tracking-wide">
        sesja {meta.id.slice(0, 8)} · {new Date(meta.lastModified).toLocaleString('pl-PL')}
      </div>
      <div className="mt-1.5 flex items-baseline gap-3.5">
        <h1 className="m-0 text-[20px] font-medium tracking-[-0.3px]">
          {meta.title}
        </h1>
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-accent bg-bg-elev-2 px-[7px] py-0.5 rounded-full">
          <span className="w-1 h-1 rounded-full bg-accent" />
          aktywna
        </span>
        <div className="ml-auto flex gap-1.5">
          <IconBtn icon="copy" label="Kopiuj ID sesji" />
          <IconBtn icon="branch" label="Fork sesji" />
          <IconBtn icon="more" label="Więcej akcji" />
        </div>
      </div>
      <div className="mt-2.5 flex gap-[18px] text-[11px] text-fg-secondary font-mono">
        <span>{meta.messageCount} tur</span>
        <span className="text-muted">·</span>
        <span>{meta.gitBranch ?? 'no branch'}</span>
      </div>
    </header>
  );
}
