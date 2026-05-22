import type { GitFile } from '../../types';
const COLOR: Record<string, string> = { M: 'text-warn', A: 'text-success', D: 'text-danger', R: 'text-accent', '?': 'text-muted' };
export function GitFileRow({ file }: { file: GitFile }) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono px-2 py-0.5 hover:bg-bg-elev-2">
      <span className={`w-3 ${COLOR[file.status] ?? 'text-muted'}`}>{file.status}</span>
      <span className="truncate flex-1" title={file.path}>{file.path}</span>
      {file.staged && <span className="text-[10px] text-success">●</span>}
    </div>
  );
}
