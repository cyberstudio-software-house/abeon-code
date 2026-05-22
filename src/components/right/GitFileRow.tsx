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
    <div className="flex items-center gap-2 text-[11.5px] px-2 py-1 hover:bg-bg-elev">
      <span className={`text-[10px] font-semibold w-3 shrink-0 ${STATUS_COLOR[file.status] ?? 'text-muted'}`}>{file.status}</span>
      <span className="truncate flex-1 text-fg" title={file.path}>{file.path}</span>
      {file.staged && <span className="text-[10px] text-success">●</span>}
    </div>
  );
}
