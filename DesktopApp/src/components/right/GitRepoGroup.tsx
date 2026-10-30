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
    <div className="flex flex-col gap-0.5 p-2 bg-bg-elev border border-border rounded-[10px]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-1 pt-1 pb-2 text-left"
        aria-label={repo.label}
        aria-expanded={!collapsed}
      >
        <Icon
          name="chevron"
          className={`w-3 h-3 text-icon transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
        <span className="text-[12.5px] text-fg-strong font-medium">{repo.label}</span>
        {repo.branch && (
          <span className="flex items-center gap-1 font-mono text-[11.5px] text-icon">
            <Icon name="branch" className="w-3 h-3" />
            {repo.branch}
          </span>
        )}
        {(repo.ahead > 0 || repo.behind > 0) && (
          <span className="font-mono text-[11.5px] text-icon">↑{repo.ahead} ↓{repo.behind}</span>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted">{repo.files.length}</span>
      </button>
      {!collapsed && (
        <GitFileList files={repo.files} onSelect={onSelectFile} />
      )}
    </div>
  );
}
