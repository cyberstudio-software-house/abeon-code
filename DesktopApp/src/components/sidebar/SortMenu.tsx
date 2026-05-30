import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import type { SortMode } from '../../store/settingsSlice';

type Option = { mode: SortMode; label: string };

const OPTIONS: Option[] = [
  { mode: 'manual',   label: 'Ręcznie' },
  { mode: 'alpha',    label: 'Alfabetycznie' },
  { mode: 'activity', label: 'Ostatnia aktywność' },
];

export function SortMenu() {
  const sortMode = useStore(s => s.sortMode);
  const setSortMode = useStore(s => s.setSortMode);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-muted hover:text-fg transition-colors p-0.5"
        aria-label="Sortuj projekty"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="sort" className="w-3.5 h-3.5" strokeWidth={2} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-10 bg-bg-elev border border-border rounded-md shadow-lg py-1 min-w-[180px]"
        >
          {OPTIONS.map(opt => (
            <button
              key={opt.mode}
              role="menuitemradio"
              aria-checked={sortMode === opt.mode}
              onClick={() => { setSortMode(opt.mode); setOpen(false); }}
              className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] text-left transition-colors ${
                sortMode === opt.mode ? 'text-fg' : 'text-muted hover:text-fg'
              }`}
            >
              <span>{opt.label}</span>
              {sortMode === opt.mode && (
                <span className="text-[11px]" aria-hidden="true">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
