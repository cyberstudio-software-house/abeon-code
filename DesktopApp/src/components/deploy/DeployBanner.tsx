import { useMemo } from 'react';
import { useStore } from '../../store';
import { visibleViews } from '../../lib/deployStatus';
import { Icon } from '../shared/Icon';
import { openPipeline } from './openPipeline';

export function DeployBanner({ projectId }: { projectId: number | null }) {
  const trackings = useStore(s => s.trackings);
  const paused = useMemo(
    () => (projectId === null ? [] : visibleViews(trackings, projectId).filter(view => view.tracking.state === 'paused')),
    [trackings, projectId],
  );
  if (paused.length === 0) return null;
  const runUrl = paused.find(view => view.tracking.runUrl)?.tracking.runUrl ?? null;
  return (
    <div
      role="status"
      className="shrink-0 h-[26px] flex items-center gap-2 pl-2.5 pr-1 rounded-full bg-accent text-accent-fg text-[12px] font-semibold whitespace-nowrap"
    >
      <Icon name="bell" className="w-3 h-3" strokeWidth={2.25} />
      <span>Pipeline czeka na Twoją akceptację</span>
      {runUrl && (
        <button
          type="button"
          onClick={() => { void openPipeline(runUrl); }}
          className="h-[20px] px-2 rounded-full bg-accent-fg text-accent text-[11.5px] font-semibold hover:opacity-90"
        >
          Otwórz pipeline
        </button>
      )}
    </div>
  );
}
