import type { GitFile } from '../../types';
import { GitFileRow } from './GitFileRow';
import { Icon } from '../shared/Icon';

type Props = {
  files: GitFile[];
  activeFilePath?: string | null;
  onSelect?: (filePath: string) => void;
};

export function GitFileList({ files, activeFilePath, onSelect }: Props) {
  if (files.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1 py-1 text-[12.5px] text-muted">
        <Icon name="check" className="w-3.5 h-3.5 shrink-0 text-success" />
        Czysto — brak zmian do zatwierdzenia
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
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
