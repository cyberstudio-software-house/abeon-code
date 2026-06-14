import { useCallback, useMemo, useState } from 'react';
import type { HistoryBlock } from '../../types';
import { blockSearchText } from '../../lib/historySearch';

export type HistorySearch = {
  query: string;
  setQuery: (q: string) => void;
  matches: number[];
  activeIndex: number;
  activeBlockIndex: number;
  count: number;
  next: () => void;
  prev: () => void;
  reset: () => void;
};

export function useHistorySearch(blocks: HistoryBlock[]): HistorySearch {
  const [query, setQueryState] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    for (let i = 0; i < blocks.length; i++) {
      if (blockSearchText(blocks[i]).toLowerCase().includes(q)) out.push(i);
    }
    return out;
  }, [blocks, query]);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setActiveIndex(0);
  }, []);

  const next = useCallback(() => {
    setActiveIndex(i => {
      if (matches.length === 0) return 0;
      const cur = Math.min(i, matches.length - 1);
      return (cur + 1) % matches.length;
    });
  }, [matches.length]);

  const prev = useCallback(() => {
    setActiveIndex(i => {
      if (matches.length === 0) return 0;
      const cur = Math.min(i, matches.length - 1);
      return (cur - 1 + matches.length) % matches.length;
    });
  }, [matches.length]);

  const reset = useCallback(() => { setQueryState(''); setActiveIndex(0); }, []);

  const safeActive = matches.length === 0 ? -1 : Math.min(activeIndex, matches.length - 1);
  const activeBlockIndex = safeActive === -1 ? -1 : matches[safeActive];

  return {
    query, setQuery,
    matches,
    activeIndex: safeActive,
    activeBlockIndex,
    count: matches.length,
    next, prev, reset,
  };
}
