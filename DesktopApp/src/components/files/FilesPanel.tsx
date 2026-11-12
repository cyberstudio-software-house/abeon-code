import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useStore } from '../../store';
import { IconBtn } from '../shared/IconBtn';
import { FileEntryMenu, type FileEntryMenuTarget } from './FileEntryMenu';
import { FileSearchResults } from './FileSearchResults';
import { FileTree } from './FileTree';

export function FilesPanel() {
  const tabs = useStore(state => state.tabs);
  const activeTabId = useStore(state => state.activeTabId);
  const projectId = tabs.find(tab => tab.id === activeTabId)?.projectId ?? null;
  const query = useStore(state => state.fileSearch.query);
  const closeFilesPanel = useStore(state => state.closeFilesPanel);
  const setFileSearchQuery = useStore(state => state.setFileSearchQuery);
  const moveFileSearchSelection = useStore(state => state.moveFileSearchSelection);
  const openFileTab = useStore(state => state.openFileTab);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<FileEntryMenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const showMenu = (event: MouseEvent, path: string) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, path });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (projectId === null) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFileSearchSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      const { results, selected } = useStore.getState().fileSearch;
      if (results[selected] !== undefined) openFileTab(projectId, results[selected]);
    } else if (event.key === 'Escape' && query !== '') {
      event.preventDefault();
      setFileSearchQuery(projectId, '');
    }
  };

  return (
    <section aria-label="Pliki" className="flex min-h-0 flex-1 flex-col gap-2 rounded-[10px] border border-border bg-bg p-2">
      <div className="flex items-center gap-1.5">
        <span className="mr-auto px-0.5 text-[11px] uppercase tracking-[0.06em] text-muted">Pliki</span>
        <IconBtn icon="close" label="Zamknij pliki" tone="ghost" onClick={closeFilesPanel} />
      </div>
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Szukaj pliku…"
        aria-label="Szukaj pliku"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => projectId !== null && setFileSearchQuery(projectId, event.target.value)}
        onKeyDown={onKeyDown}
        className="h-7 w-full rounded-md border border-border bg-sunken px-2 text-[12px] text-fg outline-none placeholder:text-muted focus:border-focus"
      />
      {projectId !== null && (query.trim() === ''
        ? <FileTree projectId={projectId} onContextMenu={showMenu} />
        : <FileSearchResults projectId={projectId} onContextMenu={showMenu} />)}
      {menu && <FileEntryMenu target={menu} onClose={closeMenu} />}
    </section>
  );
}
