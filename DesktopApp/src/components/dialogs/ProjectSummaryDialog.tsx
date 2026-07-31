import { useEffect, useState } from 'react';
import type { Project, UsageSummary } from '../../types';
import { tauri } from '../../lib/tauri';
import { formatTokens, formatCost } from '../../lib/formatUsage';

type Props = { project: Project; onClose: () => void };

function totalTokens(u: UsageSummary): number {
  return u.tokens.input + u.tokens.output + u.tokens.cacheWrite + u.tokens.cacheRead;
}

export function ProjectSummaryDialog({ project, onClose }: Props) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([tauri.projectUsage(project.id), tauri.countSessions(project.id)])
      .then(([u, c]) => { if (active) { setUsage(u); setCount(c); } })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project.id]);

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border p-5 w-[460px]" onClick={e => e.stopPropagation()}>
        <h2 className="text-[14px] font-semibold mb-3">Podsumowanie — {project.name}</h2>
        {loading ? (
          <div className="text-[12px] text-muted py-4">Ładowanie…</div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 mb-4 text-[12px]">
              <div className="flex justify-between"><span className="text-muted">Sesje</span><span className="tabular-nums">{count ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted">Tokeny</span><span className="tabular-nums">{usage ? `${formatTokens(totalTokens(usage))} tok` : '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted">Koszt</span><span className="tabular-nums font-medium">{usage ? `~${formatCost(usage.costUsd)}` : '—'}</span></div>
            </div>
            {usage && usage.byModel.length > 0 && (
              <table className="w-full text-[11.5px] mb-3">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-medium pb-1">Model</th>
                    <th className="font-medium pb-1 text-right">Tokeny</th>
                    <th className="font-medium pb-1 text-right">Koszt</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map(m => (
                    <tr key={m.model} className="border-t border-border">
                      <td className="py-1 pr-2 truncate max-w-[220px]">{m.model}</td>
                      <td className="py-1 text-right tabular-nums">{formatTokens(m.tokens.input + m.tokens.output + m.tokens.cacheWrite + m.tokens.cacheRead)}</td>
                      <td className="py-1 text-right tabular-nums">{formatCost(m.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {usage && usage.unknownModels.length > 0 && (
              <div className="text-[11px] text-warn mb-2">Bez ceny: {usage.unknownModels.join(', ')}</div>
            )}
          </>
        )}
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Zamknij</button>
        </div>
      </div>
    </div>
  );
}
