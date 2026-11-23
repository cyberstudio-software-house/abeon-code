import { useState } from 'react';
import { toast } from 'sonner';
import { useStore } from '../../store';
import { formatTauriError } from '../../lib/errors';
import type { ProposalView } from '../../types';

const STALE_MESSAGE = 'Przepływ zmienił się po propozycji — sprawdź w aplikacji';

export function FlowProposalCard({ view }: { view: ProposalView }) {
  const resolveProposal = useStore(state => state.resolveProposal);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const title = `Agent proponuje przepływ wdrożenia: ${view.repoLabel}`;
  const outdated = refused || view.proposal.baseUpdatedAt !== view.currentUpdatedAt;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setRefused(false);
    try {
      const outcome = await resolveProposal(view.proposal.id, approve, view.currentUpdatedAt);
      if (outcome === 'stale') {
        setRefused(true);
        setBusy(false);
      }
    } catch (error) {
      toast.error(formatTauriError(error));
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={title}
      className="w-full rounded-lg border border-accent bg-bg-elev p-3 shadow-lg space-y-2"
    >
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold text-fg-strong">{title}</h2>
        <p className="truncate font-mono text-[11px] text-muted" title={view.proposal.repoPath}>
          {view.proposal.repoPath}
        </p>
      </div>
      <ul className="max-h-[40vh] overflow-y-auto space-y-0.5 text-[12px] text-fg">
        {view.changes.map(change => (
          <li key={change.field} className="break-words">
            <span className="text-fg-secondary">{change.label}:</span>{' '}
            {change.before !== null && (
              <>
                <span className="font-mono">{change.before}</span>{' → '}
              </>
            )}
            <span className="font-mono text-fg-strong">{change.after}</span>
          </li>
        ))}
      </ul>
      {outdated && <p role="alert" className="text-[11px] text-danger">{STALE_MESSAGE}</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => void decide(false)} disabled={busy} className="btn-secondary">
          Odrzuć
        </button>
        <button type="button" onClick={() => void decide(true)} disabled={busy} className="btn-primary">
          Zatwierdź
        </button>
      </div>
    </section>
  );
}
