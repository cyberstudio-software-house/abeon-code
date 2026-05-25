import type { GitRepo } from '../../types';
import { GitFileList } from './GitFileList';
import { Icon } from '../shared/Icon';

type Props = {
  repo: GitRepo;
  collapsed: boolean;
  onToggle: () => void;
  onSelectFile?: (filePath: string) => void;
};

export function GitRepoGroup({ repo, collapsed, onToggle, onSelectFile }: Props) {
  return (
    <div className="mb-3 last:mb-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 bg-bg-elev hover:bg-bg-elev/80 text-left"
        aria-label={repo.label}
      >
        <Icon
          name="chevron"
          className={`w-3 h-3 text-fg-secondary transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
        <span className="text-[12px] text-fg font-medium">{repo.label}</span>
        {repo.branch && (
          <span className="flex items-center gap-1 text-[10.5px] text-muted">
            <Icon name="branch" className="w-3 h-3" />
            {repo.branch}
          </span>
        )}
        {(repo.ahead > 0 || repo.behind > 0) && (
          <span className="text-[10px] text-muted">↑{repo.ahead} ↓{repo.behind}</span>
        )}
        <span className="ml-auto text-[10px] text-muted">{repo.files.length}</span>
      </button>
      {!collapsed && (
        <GitFileList files={repo.files} onSelect={onSelectFile} />
      )}
    </div>
  );
}
