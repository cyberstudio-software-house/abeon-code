import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import type { Project } from '../../types';
import { SessionList } from './SessionList';
import { ProjectActionsMenu } from './ProjectActionsMenu';
import { Icon } from '../shared/Icon';
import { tauri } from '../../lib/tauri';
import { ProjectManageMenu } from './ProjectManageMenu';
import { EditProjectDialog } from '../dialogs/EditProjectDialog';
import { ProjectSummaryDialog } from '../dialogs/ProjectSummaryDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { getProjectColor } from '../../lib/projectColors';

type Props = { project: Project };

export function ProjectItem({ project }: Props) {
  const expanded = useStore(s => s.expandedProjectIds.has(project.id));
  const toggle = useStore(s => s.toggleProjectExpanded);
  const openNew = useStore(s => s.openNewSessionTab);
  const openTerminal = useStore(s => s.openTerminal);
  const [count, setCount] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const manageRef = useRef<HTMLDivElement | null>(null);
  const removeProject = useStore(s => s.removeProject);
  const actions = useStore(s => s.actionsByProject[project.id]);
  const runningActions = useStore(s => s.runningActions);
  const hasActive = (actions ?? []).some(a => runningActions[a.id]);

  useEffect(() => {
    tauri.countSessions(project.id).then(setCount).catch(() => {});
  }, [project.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!manageOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (manageRef.current && !manageRef.current.contains(e.target as Node)) setManageOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [manageOpen]);

  return (
    <li>
      <div className="relative group/proj" ref={manageRef}>
        <button
          onClick={() => toggle(project.id)}
          onContextMenu={(e) => { e.preventDefault(); setMenuOpen(false); setManageOpen(true); }}
          aria-expanded={expanded}
          className={`group w-full h-7 flex items-center gap-2 px-2 rounded-[7px] text-left text-[13px] transition-colors ${
            expanded ? 'bg-bg-elev-2 text-fg-strong' : 'text-fg-secondary hover:bg-bg-elev-2 hover:text-fg-strong'
          }`}
        >
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: getProjectColor(project) }} />
          <span className="flex-1 min-w-0 truncate">{project.name}</span>
          {count !== null && (
            <span className={`font-mono text-[11px] text-label tabular-nums transition-opacity ${manageOpen ? 'opacity-0' : 'group-hover/proj:opacity-0'}`}>{count}</span>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setManageOpen(o => !o); }}
          className={`absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 grid place-items-center rounded-[5px] text-icon hover:bg-track hover:text-fg-strong transition-opacity ${manageOpen ? 'opacity-100' : 'opacity-0 group-hover/proj:opacity-100'}`}
          title="Zarządzaj projektem"
          aria-label="Zarządzaj projektem"
        >
          <Icon name="more" className="w-3 h-3" strokeWidth={2} />
        </button>
        {manageOpen && (
          <div className="absolute right-1 top-full z-30 mt-0.5 menu-panel w-44">
            <ProjectManageMenu
              onSummary={() => setSummaryOpen(true)}
              onEdit={() => setEditing(true)}
              onDelete={() => setConfirmingDelete(true)}
              onClose={() => setManageOpen(false)}
            />
          </div>
        )}
      </div>
      {expanded && (
        <div className="mt-0.5 mb-2 ml-3 pl-2.5 border-l border-border-subtle">
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); openNew(project.id); }}
              className="flex-1 flex items-center gap-1.5 pr-2 py-1.5 text-[11.5px] text-label hover:text-fg-strong transition-colors"
            >
              <Icon name="plus" className="w-3 h-3" strokeWidth={2} />
              <span>New session</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); openTerminal(project.id, { toggle: false }); }}
              className="flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-label hover:text-fg-strong hover:bg-bg-elev-2 transition-colors rounded-md"
              title="New terminal"
            >
              <Icon name="terminal" className="w-3 h-3" strokeWidth={2} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                tauri.openProjectInEditor(project.path).catch(err =>
                  console.warn('[editor] open failed:', err)
                );
              }}
              className="flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-label hover:text-fg-strong hover:bg-bg-elev-2 transition-colors rounded-md"
              title="Open in editor"
            >
              <Icon name="code" className="w-3 h-3" strokeWidth={2} />
            </button>
            <div className="relative" ref={menuRef}>
              <button
                onClick={(e) => { e.stopPropagation(); setManageOpen(false); setMenuOpen(o => !o); }}
                className="relative flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-label hover:text-fg-strong hover:bg-bg-elev-2 transition-colors rounded-md"
                title="Akcje"
              >
                <Icon name="layers" className="w-3 h-3" strokeWidth={2} />
                {hasActive && (
                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-success" />
                )}
              </button>
              {menuOpen && (
                <div className="absolute right-0 z-20 mt-1 menu-panel w-56 max-h-72 overflow-y-auto">
                  <ProjectActionsMenu projectId={project.id} onClose={() => setMenuOpen(false)} />
                </div>
              )}
            </div>
          </div>
          <SessionList projectId={project.id} />
        </div>
      )}
      {editing && <EditProjectDialog project={project} onClose={() => setEditing(false)} />}
      {summaryOpen && <ProjectSummaryDialog project={project} onClose={() => setSummaryOpen(false)} />}
      {confirmingDelete && (
        <ConfirmDialog
          title="Usuń projekt"
          confirmLabel="Usuń"
          message={`Usunąć projekt „${project.name}"? Tej operacji nie można cofnąć.`}
          onConfirm={() => { void removeProject(project.id).catch(err => console.error('[projects] removeProject failed', err)); setConfirmingDelete(false); }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </li>
  );
}
