import { Fragment, memo, useCallback, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { gitStatusByPath } from '../../lib/fileGitStatus';
import { fileDir } from '../../lib/fileText';
import { childPath, TREE_RENDER_LIMIT } from '../../store/filesSlice';
import { useStore } from '../../store';
import type { FileEntry } from '../../types';
import { gitStatusColor } from '../right/GitFileRow';
import { Icon } from '../shared/Icon';

type ContextMenuHandler = (event: MouseEvent, path: string) => void;
type ActivateHandler = (path: string, isDir: boolean) => void;

type Props = {
  projectId: number;
  onContextMenu: ContextMenuHandler;
};

const INDENT_PX = 12;
const BASE_PADDING_PX = 6;

type RowProps = {
  entry: FileEntry;
  path: string;
  depth: number;
  expanded: boolean;
  selected: boolean;
  gitStatus: string | undefined;
  onActivate: ActivateHandler;
  onContextMenu: ContextMenuHandler;
};

const FileTreeRow = memo(function FileTreeRow({ entry, path, depth, expanded, selected, gitStatus, onActivate, onContextMenu }: RowProps) {
  const isDir = entry.kind === 'dir';
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(path, isDir);
    }
  };

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-level={depth + 1}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      onClick={() => onActivate(path, isDir)}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => onContextMenu(event, path)}
      style={{ paddingLeft: BASE_PADDING_PX + depth * INDENT_PX }}
      className={`flex h-6 cursor-pointer items-center gap-1.5 rounded-md pr-1.5 outline-none transition-colors hover:bg-bg-elev-2 focus-visible:bg-bg-elev-2 ${selected ? 'bg-bg-elev-2' : ''} ${entry.ignored ? 'opacity-50' : ''}`}
    >
      {isDir
        ? <Icon name="chevR" className={`h-3 w-3 shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
        : <span className="w-3 shrink-0" />}
      <Icon name={isDir ? 'folder' : 'file'} className="h-3 w-3 shrink-0 text-icon" />
      <span className={`min-w-0 flex-1 truncate font-mono text-[12px] ${gitStatus ? gitStatusColor(gitStatus) : 'text-fg'}`}>
        {entry.name}
      </span>
      {gitStatus && (
        <span className={`font-mono text-[11px] font-medium ${gitStatusColor(gitStatus)}`}>{gitStatus}</span>
      )}
    </div>
  );
});

type DirProps = {
  projectId: number;
  relDir: string;
  depth: number;
  activePath: string | null;
  statusByPath: Map<string, string>;
  onActivate: ActivateHandler;
  onContextMenu: ContextMenuHandler;
};

const FileTreeDir = memo(function FileTreeDir({ projectId, relDir, depth, activePath, statusByPath, onActivate, onContextMenu }: DirProps) {
  const listing = useStore(state => state.fileTrees[projectId]?.listings[relDir]);
  const expandedChildren = useStore(useShallow(state => (
    (state.fileTrees[projectId]?.expanded ?? []).filter(dir => dir !== relDir && fileDir(dir) === relDir)
  )));
  const reloadFileDir = useStore(state => state.reloadFileDir);
  const padding = BASE_PADDING_PX + depth * INDENT_PX;

  if (listing?.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-1 py-1 text-[12px]" style={{ paddingLeft: padding }}>
        <span className="text-danger">Nie udało się wczytać katalogu</span>
        <button type="button" className="btn-secondary h-6 px-2 text-[12px]" onClick={() => void reloadFileDir(projectId, relDir)}>
          Spróbuj ponownie
        </button>
      </div>
    );
  }
  if (!listing || (listing.status === 'loading' && listing.entries.length === 0)) {
    return (
      <div className="py-1 text-[12px] text-muted" style={{ paddingLeft: padding }}>
        Wczytywanie…
      </div>
    );
  }
  const shown = listing.entries.slice(0, TREE_RENDER_LIMIT);
  return (
    <>
      {shown.map((entry) => {
        const path = childPath(relDir, entry.name);
        const isDir = entry.kind === 'dir';
        const expanded = isDir && expandedChildren.includes(path);
        return (
          <Fragment key={path}>
            <FileTreeRow
              entry={entry}
              path={path}
              depth={depth}
              expanded={expanded}
              selected={!isDir && path === activePath}
              gitStatus={isDir ? undefined : statusByPath.get(path)}
              onActivate={onActivate}
              onContextMenu={onContextMenu}
            />
            {expanded && (
              <FileTreeDir
                projectId={projectId}
                relDir={path}
                depth={depth + 1}
                activePath={activePath}
                statusByPath={statusByPath}
                onActivate={onActivate}
                onContextMenu={onContextMenu}
              />
            )}
          </Fragment>
        );
      })}
      {listing.entries.length > TREE_RENDER_LIMIT && (
        <div className="py-1 text-[11px] text-muted" style={{ paddingLeft: padding }}>
          pokazano pierwsze {TREE_RENDER_LIMIT}
        </div>
      )}
    </>
  );
});

export function FileTree({ projectId, onContextMenu }: Props) {
  const gitStatus = useStore(state => state.gitByProject[projectId]);
  const activePath = useStore(state => {
    const tab = state.tabs.find(item => item.id === state.activeTabId);
    return tab?.kind === 'file' && tab.projectId === projectId ? tab.path : null;
  });
  const toggleFileDir = useStore(state => state.toggleFileDir);
  const openFileTab = useStore(state => state.openFileTab);
  const statusByPath = useMemo(() => gitStatusByPath(gitStatus), [gitStatus]);
  const onActivate = useCallback<ActivateHandler>((path, isDir) => {
    if (isDir) void toggleFileDir(projectId, path);
    else openFileTab(projectId, path);
  }, [projectId, toggleFileDir, openFileTab]);

  return (
    <div role="tree" aria-label="Pliki projektu" className="min-h-0 flex-1 overflow-y-auto">
      <FileTreeDir
        projectId={projectId}
        relDir=""
        depth={0}
        activePath={activePath}
        statusByPath={statusByPath}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
      />
    </div>
  );
}
