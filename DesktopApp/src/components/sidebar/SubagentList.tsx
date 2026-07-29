import type { SubagentInfo } from '../../types';

const STATUS_MARK: Record<SubagentInfo['status'], string> = {
  running: '●',
  completed: '✓',
  stale: '⚠',
};

const STATUS_TONE: Record<SubagentInfo['status'], string> = {
  running: 'text-accent',
  completed: 'text-muted',
  stale: 'text-warn',
};

const STATUS_LABEL: Record<SubagentInfo['status'], string> = {
  running: 'Pracuje',
  completed: 'Zakończony',
  stale: 'Przerwany',
};

function duration(a: SubagentInfo): string {
  const end = a.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - a.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

type Props = { agents: SubagentInfo[]; onPick: (agentId: string) => void };

export function SubagentList({ agents, onPick }: Props) {
  if (agents.length === 0) {
    return <li className="pl-7 py-1 text-[11px] text-muted">Brak agentów</li>;
  }

  return (
    <>
      {agents.map(a => (
        <li
          key={a.agentId}
          onClick={e => { e.stopPropagation(); onPick(a.agentId); }}
          title={`${STATUS_LABEL[a.status]} · ${a.description}`}
          className="pl-7 pr-2 py-1 text-[11px] cursor-pointer flex items-center gap-2 text-fg hover:bg-bg-elev"
        >
          <span className={`shrink-0 ${STATUS_TONE[a.status]}`}>{STATUS_MARK[a.status]}</span>
          <span className="shrink-0 text-muted">{a.agentType}</span>
          <span className="truncate flex-1 min-w-0">{a.description}</span>
          <span className="font-mono text-[10px] text-muted shrink-0">{duration(a)}</span>
        </li>
      ))}
    </>
  );
}
