import type { GitFile } from '../../types';
import { GitFileRow } from './GitFileRow';

type Props = {
  files: GitFile[];
  activeFilePath?: string | null;
  onSelect?: (filePath: string) => void;
};

export function GitFileList({ files, activeFilePath, onSelect }: Props) {
  if (files.length === 0) return <div className="text-[12px] text-muted px-2">Czysto</div>;
  return (
    <div className="space-y-0">
      {files.map((f, i) => (
        <GitFileRow
          key={`${f.path}-${i}`}
          file={f}
          active={activeFilePath === f.path}
          onClick={onSelect ? () => onSelect(f.path) : undefined}
        />
      ))}
    </div>
  );
}
