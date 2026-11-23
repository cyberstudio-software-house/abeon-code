import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import { TONE_DOT, projectTracking, trackingLabel, trackingTone, type DeployTone } from '../../lib/deployStatus';
import { Icon } from '../shared/Icon';
import { DeployDetailsDialog } from './DeployDetailsDialog';

const TONE_TEXT: Record<DeployTone, string> = {
  running: 'text-accent',
  attention: 'text-accent-fg',
  problem: 'text-danger',
  done: 'text-success',
  muted: 'text-muted',
};

type Props = {
  projectId: number;
  showLabel?: boolean;
  className?: string;
};

export function DeployStatusChip({ projectId, showLabel = false, className = '' }: Props) {
  const trackings = useStore(s => s.trackings);
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => projectTracking(trackings, projectId), [trackings, projectId]);

  const dialog = open
    ? createPortal(<DeployDetailsDialog projectId={projectId} onClose={() => setOpen(false)} />, document.body)
    : null;
  if (!summary) return dialog;

  const { top, count } = summary;
  const label = trackingLabel(top.tracking);
  const tone = trackingTone(top.tracking);
  const title = `${top.repoLabel}: ${label}`;
  const extra = count > 1 ? <span className="font-mono text-[11px] tabular-nums opacity-80">+{count - 1}</span> : null;

  const shape = tone === 'attention'
    ? `h-[20px] px-2 rounded-full bg-accent ${TONE_TEXT.attention} font-semibold`
    : `h-[22px] px-1.5 rounded-md hover:bg-track ${TONE_TEXT[tone]}`;

  return (
    <>
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={() => setOpen(true)}
        className={`shrink-0 flex items-center gap-1.5 text-[12px] whitespace-nowrap ${shape} ${className}`}
      >
        {tone === 'attention'
          ? <Icon name="bell" className="w-3 h-3" strokeWidth={2.25} />
          : <span aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[tone]}`} />}
        {showLabel && <span>{label}</span>}
        {extra}
      </button>
      {dialog}
    </>
  );
}
