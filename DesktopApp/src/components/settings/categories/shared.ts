import { useCallback, useEffect, useState } from 'react';
import { FALLBACK_EFFORT_LEVELS } from '../../../lib/models';
import { tauri } from '../../../lib/tauri';
import type { ClaudeOptions } from '../../../types';

export const SELECT_BASE =
  'bg-bg-elev-2 border border-border rounded text-fg cursor-pointer transition-colors hover:border-muted focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed';

export const AUTO_MODEL_LABEL = 'Auto (domyślny model Claude)';

export function useClaudeOptions() {
  const [options, setOptions] = useState<ClaudeOptions>({ models: [], effortLevels: FALLBACK_EFFORT_LEVELS });
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback((force?: boolean) => {
    setRefreshing(true);
    tauri.detectClaudeOptions(force)
      .then(setOptions)
      .catch(() => setOptions({ models: [], effortLevels: FALLBACK_EFFORT_LEVELS }))
      .finally(() => {
        setLoaded(true);
        setRefreshing(false);
      });
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { options, loaded, refreshing, refresh };
}
