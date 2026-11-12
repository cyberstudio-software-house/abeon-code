import { useEffect, useRef, type MouseEvent } from 'react';
import { fileDir, fileName } from '../../lib/fileText';
import { useStore } from '../../store';

type Props = {
  projectId: number;
  onContextMenu: (event: MouseEvent, path: string) => void;
};

export function FileSearchResults({ projectId, onContextMenu }: Props) {
  const search = useStore(state => state.fileSearch);
  const openFileTab = useStore(state => state.openFileTab);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [search.selected, search.results]);

  if (search.status === 'error') {
    return <p className="px-1 text-[12px] text-danger">Nie udało się wyszukać plików</p>;
  }
  if (search.status === 'ready' && search.results.length === 0) {
    return <p className="px-1 text-[12px] text-muted">Brak wyników</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div role="listbox" aria-label="Wyniki wyszukiwania" className="flex flex-col gap-px">
        {search.results.map((path, index) => {
          const dir = fileDir(path);
          const selected = index === search.selected;
          return (
            <button
              key={path}
              ref={selected ? selectedRef : undefined}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => openFileTab(projectId, path)}
              onContextMenu={(event) => onContextMenu(event, path)}
              className={`flex w-full flex-col items-start rounded-md px-1.5 py-1 text-left transition-colors hover:bg-bg-elev-2 ${selected ? 'bg-bg-elev-2' : ''}`}
            >
              <span className="w-full truncate font-mono text-[12px] text-fg">{fileName(path)}</span>
              {dir && <span className="w-full truncate font-mono text-[11px] text-muted">{dir}</span>}
            </button>
          );
        })}
      </div>
      {search.truncated && <p className="px-1.5 pt-1 text-[11px] text-muted">pokazano pierwsze 200</p>}
    </div>
  );
}
