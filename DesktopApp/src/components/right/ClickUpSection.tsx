import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { LinkClickUpTaskDialog } from '../dialogs/LinkClickUpTaskDialog';
import { ClickUpTaskDialog } from '../dialogs/ClickUpTaskDialog';
import { ClickUpScopeDialog } from './ClickUpScopeDialog';
import { Icon } from '../shared/Icon';

export function ClickUpSection({ detached = false }: { detached?: boolean }) {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const connectionStatus = useStore(s => s.connectionStatus);
  const linksByProject = useStore(s => s.linksByProject);
  const configByProject = useStore(s => s.configByProject);
  const loadLinks = useStore(s => s.loadLinks);
  const loadConfig = useStore(s => s.loadConfig);
  const loadConnectionStatus = useStore(s => s.loadConnectionStatus);
  const openSettings = useStore(s => s.openSettings);

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

  if (activeProjectId == null || connectionStatus === 'absent') return null;

  const config = configByProject[activeProjectId];
  const list = linksByProject[activeProjectId] ?? [];

  const showScopeButton = connectionStatus === 'configured' && !!config;

  return (
    <section aria-labelledby="clickup-section-title" className="shrink-0 flex flex-col gap-1.5">
      <div className="h-[26px] flex items-center gap-0.5 pl-1 pb-1">
        <h2 id="clickup-section-title" className="flex-1 text-[11px] text-label font-medium uppercase tracking-[0.06em]">
          Zadania ClickUp
        </h2>
        {showScopeButton && (
          <button
            aria-label="Zakres ClickUp"
            title="Zakres ClickUp"
            onClick={() => setScopeOpen(true)}
            className="w-[26px] h-[26px] rounded-md grid place-items-center text-icon hover:bg-bg-elev-2 hover:text-fg-strong transition-colors"
          >
            <Icon name="sliders" className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {connectionStatus !== 'configured' ? (
        <div className="flex flex-col items-start gap-2.5 p-3 rounded-[10px] bg-bg-elev border border-danger/30">
          <div className="flex gap-2.5">
            <svg
              width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className="shrink-0 mt-0.5 text-danger"
            >
              <path d="M8 1.8 14.5 13.5h-13z" />
              <path d="M8 6.5v3M8 11.6v.1" />
            </svg>
            <div className="flex flex-col gap-1">
              <p className="text-[12.5px] leading-[1.5] text-fg-secondary">
                Token ClickUp jest nieprawidłowy albo wygasł. Zadania nie będą się odświeżać.
              </p>
              {detached && (
                <p className="text-[12.5px] leading-[1.5] text-muted">Popraw token w ustawieniach głównego okna.</p>
              )}
            </div>
          </div>
          {!detached && (
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => openSettings('clickup')}
              className="h-[30px] flex items-center gap-1.5 px-3 rounded-lg bg-button border border-border-strong text-[12.5px] text-fg-strong hover:bg-bg-elev-2 transition-colors"
            >
              Otwórz ustawienia ClickUp
              <Icon name="chevR" className="w-3 h-3" />
            </button>
          )}
        </div>
      ) : !config ? (
        <div className="flex flex-col items-start gap-2.5 p-3 rounded-[10px] bg-bg-elev border border-border">
          <div className="flex gap-2.5">
            <Icon name="sliders" className="shrink-0 mt-0.5 w-[15px] h-[15px] text-icon" />
            <p className="text-[12.5px] leading-[1.5] text-fg-secondary">
              Wybierz workspace i space, z których mają pochodzić zadania tego projektu.
            </p>
          </div>
          <button
            onClick={() => setScopeOpen(true)}
            className="h-[30px] px-3 rounded-lg bg-button border border-border-strong text-[12.5px] text-fg-strong hover:bg-bg-elev-2 transition-colors"
          >
            Ustaw zakres
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-start gap-2.5 px-3 py-3.5 rounded-[10px] border border-dashed border-border-strong">
          <p className="text-[12.5px] leading-[1.5] text-muted">Ten projekt nie ma jeszcze powiązanych zadań.</p>
          <button
            onClick={() => setLinkOpen(true)}
            className="h-[30px] flex items-center gap-1.5 pl-2 pr-2.5 rounded-lg bg-button border border-border-strong text-[12.5px] text-fg-strong hover:bg-bg-elev-2 transition-colors"
          >
            <Icon name="plus" className="w-[13px] h-[13px]" />
            Powiąż zadania
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {list.map(l => (
            <button
              key={l.taskId}
              onClick={() => setOpenTaskId(l.taskId)}
              className="h-8 flex items-center gap-2.5 pl-1 pr-1.5 rounded-[7px] text-left hover:bg-bg-elev-2 transition-colors"
            >
              <span className="shrink-0 font-mono text-[11px] text-muted">{l.customId ?? l.taskId.slice(0, 6)}</span>
              <span className="flex-1 min-w-0 truncate text-[13px] text-fg">{l.name}</span>
              {l.status && (
                <span className="shrink-0 h-5 inline-flex items-center px-[7px] rounded-full bg-bg-elev-2 border border-border text-[11px] text-icon whitespace-nowrap">
                  {l.status}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => setLinkOpen(true)}
            className="self-start mt-0.5 h-7 flex items-center gap-1.5 pl-1.5 pr-2 rounded-[7px] text-[12.5px] text-icon hover:bg-bg-elev-2 hover:text-fg-strong transition-colors"
          >
            <Icon name="plus" className="w-[13px] h-[13px]" />
            Powiąż zadania
          </button>
        </div>
      )}

      {linkOpen && <LinkClickUpTaskDialog projectId={activeProjectId} onClose={() => setLinkOpen(false)} />}
      {scopeOpen && <ClickUpScopeDialog projectId={activeProjectId} onClose={() => setScopeOpen(false)} />}
      {openTaskId && (
        <ClickUpTaskDialog projectId={activeProjectId} taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
      )}
    </section>
  );
}
