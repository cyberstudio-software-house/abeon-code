import type { GitFile } from '../../types';
import { GitFileRow } from './GitFileRow';
export function GitFileList({ files }: { files: GitFile[] }) {
  if (files.length === 0) return <div className="text-[12px] text-muted px-2">Czysto</div>;
  return <div className="space-y-0">{files.map((f, i) => <GitFileRow key={`${f.path}-${i}`} file={f} />)}</div>;
}
