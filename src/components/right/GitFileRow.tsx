import type { GitFile } from '../../types';

const STATUS_COLOR: Record<string, string> = {
  M: 'text-accent',
  A: 'text-success',
  D: 'text-danger',
  R: 'text-fg-secondary',
  '?': 'text-muted',
};

export function GitFileRow({ file }: { file: GitFile }) {
  return (
    <button className="w-full flex items-center gap-2 px-2 py-[5px] border-b border-border/50 hover:bg-bg-elev transition-colors text-left">
      <span className={`font-mono text-[10px] w-3 text-center font-semibold ${STATUS_COLOR[file.status] ?? 'text-muted'}`}>
        {file.status}
      </span>
      <span className="flex-1 min-w-0 font-mono text-[11.5px] text-fg path-ellipsis">
        {file.path}
      </span>
      {file.additions > 0 && (
        <span className="font-mono text-[10px] text-success tabular-nums">+{file.additions}</span>
      )}
      {file.deletions > 0 && (
        <span className="font-mono text-[10px] text-danger tabular-nums">−{file.deletions}</span>
      )}
    </button>
  );
}
