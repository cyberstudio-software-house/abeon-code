import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { LinkClickUpTaskDialog } from '../dialogs/LinkClickUpTaskDialog';
import { ClickUpTaskDialog } from '../dialogs/ClickUpTaskDialog';
import { ClickUpScopeDialog } from './ClickUpScopeDialog';
import { Icon } from '../shared/Icon';

export function ClickUpSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const connectionStatus = useStore(s => s.connectionStatus);
  const linksByProject = useStore(s => s.linksByProject);
  const configByProject = useStore(s => s.configByProject);
  const loadLinks = useStore(s => s.loadLinks);
  const loadConfig = useStore(s => s.loadConfig);
  const loadConnectionStatus = useStore(s => s.loadConnectionStatus);

  const activeProjectId = tabs.find(t => t.id === activeTabId)?.projectId ?? null;

  const [linkOpen, setLinkOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  useEffect(() => { void loadConnectionStatus(); }, [loadConnectionStatus]);
  useEffect(() => {
    if (activeProjectId != null) {
      void loadLinks(activeProjectId);
      void loadConfig(activeProjectId);
    }
  }, [activeProjectId, loadLinks, loadConfig]);

  if (activeProjectId == null) return null;

  const config = configByProject[activeProjectId];
  const list = linksByProject[activeProjectId] ?? [];

  return (
    <section className="shrink-0">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">ZADANIA CLICKUP</span>
        <button className="text-muted hover:text-fg" title="Zakres" onClick={() => setScopeOpen(true)}>
          <Icon name="settings" className="w-[13px] h-[13px]" />
        </button>
      </div>

      {connectionStatus !== 'configured' ? (
        <p className="text-[11px] text-muted">Skonfiguruj ClickUp w ustawieniach.</p>
      ) : !config ? (
        <p className="text-[11px] text-muted">Ustaw zakres (workspace/space) ikoną powyżej.</p>
      ) : (
        <>
          <div className="space-y-0.5">
            {list.map(l => (
              <button
                key={l.taskId}
                onClick={() => setOpenTaskId(l.taskId)}
                className="w-full text-left px-2 py-1 hover:bg-bg-elev-2 text-[11px] flex items-center gap-2"
              >
                <span className="text-muted font-mono">{l.customId ?? l.taskId.slice(0, 6)}</span>
                <span className="flex-1 truncate text-fg">{l.name}</span>
                {l.status && <span className="text-[10px] text-fg-secondary">{l.status}</span>}
              </button>
            ))}
            {list.length === 0 && <p className="text-[11px] text-muted px-2 py-1">Brak powiązanych zadań.</p>}
          </div>
          <button className="mt-2 text-[11px] text-accent hover:underline" onClick={() => setLinkOpen(true)}>
            + powiąż zadania
          </button>
        </>
      )}

      {linkOpen && <LinkClickUpTaskDialog projectId={activeProjectId} onClose={() => setLinkOpen(false)} />}
      {scopeOpen && <ClickUpScopeDialog projectId={activeProjectId} onClose={() => setScopeOpen(false)} />}
      {openTaskId && (
        <ClickUpTaskDialog projectId={activeProjectId} taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
      )}
    </section>
  );
}
