import type { GitFile } from '../../types';

const STATUS_COLOR: Record<string, string> = {
  M: 'text-accent',
  A: 'text-success',
  D: 'text-danger',
  R: 'text-fg-secondary',
  '?': 'text-muted',
};

type Props = {
  file: GitFile;
  active?: boolean;
  onClick?: () => void;
};

export function GitFileRow({ file, active, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full h-7 flex items-center gap-2 px-1.5 rounded-md hover:bg-bg-elev-2 transition-colors text-left ${active ? 'bg-bg-elev-2' : ''}`}
    >
      <span className={`font-mono text-[11px] w-3.5 font-medium ${STATUS_COLOR[file.status] ?? 'text-muted'}`}>
        {file.status}
      </span>
      <span className="flex-1 min-w-0 font-mono text-[12px] text-fg path-ellipsis">
        {file.path}
      </span>
      {file.additions > 0 && (
        <span className="font-mono text-[11px] text-success tabular-nums">+{file.additions}</span>
      )}
      {file.deletions > 0 && (
        <span className="font-mono text-[11px] text-danger tabular-nums">−{file.deletions}</span>
      )}
    </button>
  );
}
