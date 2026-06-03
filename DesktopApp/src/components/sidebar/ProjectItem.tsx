import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import type { Project } from '../../types';
import { SessionList } from './SessionList';
import { ProjectActionsMenu } from './ProjectActionsMenu';
import { Icon } from '../shared/Icon';
import { tauri } from '../../lib/tauri';
import { ProjectManageMenu } from './ProjectManageMenu';
import { EditProjectDialog } from '../dialogs/EditProjectDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

type Props = { project: Project };

export function ProjectItem({ project }: Props) {
  const expanded = useStore(s => s.expandedProjectIds.has(project.id));
  const toggle = useStore(s => s.toggleProjectExpanded);
  const openNew = useStore(s => s.openNewSessionTab);
  const openTerminal = useStore(s => s.openNewTerminalTab);
  const [count, setCount] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [editing, setEditing] = useState(false);
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
    <li className="py-0.5">
      <button
        onClick={() => toggle(project.id)}
        onContextMenu={(e) => { e.preventDefault(); if (!expanded) toggle(project.id); setMenuOpen(false); setManageOpen(true); }}
        className={`group w-full flex items-center gap-2 px-2.5 py-[7px] rounded-md text-left transition-colors ${
          expanded ? 'bg-bg-elev border border-border' : 'border border-transparent hover:bg-bg-elev'
        }`}
      >
        <Icon
          name="chevR"
          className={`w-2.5 h-2.5 text-fg-secondary transition-transform ${expanded ? 'rotate-90' : ''}`}
          strokeWidth={2.5}
        />
        <div className="min-w-0 flex-1 flex items-center gap-1.5">
          {project.color && (
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: project.color }} />
          )}
          <div className={`text-[12.5px] truncate ${expanded ? 'font-semibold text-fg' : 'font-medium text-fg'}`}>
            {project.name}
          </div>
        </div>
        {count !== null && (
          <span className="font-mono text-[10px] text-muted tabular-nums">{count}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 mb-2.5 ml-4 pl-3.5 border-l border-border">
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); openNew(project.id); }}
              className="flex-1 flex items-center gap-1.5 pr-2 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors"
            >
              <Icon name="plus" className="w-3 h-3" strokeWidth={2} />
              <span>New session</span>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); openTerminal(project.id); }}
              className="flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors rounded"
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
              className="flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors rounded"
              title="Open in editor"
            >
              <Icon name="code" className="w-3 h-3" strokeWidth={2} />
            </button>
            <div className="relative" ref={menuRef}>
              <button
                onClick={(e) => { e.stopPropagation(); setManageOpen(false); setMenuOpen(o => !o); }}
                className="relative flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors rounded"
                title="Akcje"
              >
                <Icon name="layers" className="w-3 h-3" strokeWidth={2} />
                {hasActive && (
                  <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-success" />
                )}
              </button>
              {menuOpen && (
                <div className="absolute right-0 z-20 mt-1 w-56 max-h-72 overflow-y-auto rounded-md border border-border bg-bg shadow-lg">
                  <ProjectActionsMenu projectId={project.id} onClose={() => setMenuOpen(false)} />
                </div>
              )}
            </div>
            <div className="relative" ref={manageRef}>
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setManageOpen(o => !o); }}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors rounded"
                title="Zarządzaj projektem"
              >
                <Icon name="more" className="w-3 h-3" strokeWidth={2} />
              </button>
              {manageOpen && (
                <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-border bg-bg shadow-lg">
                  <ProjectManageMenu
                    onEdit={() => setEditing(true)}
                    onDelete={() => setConfirmingDelete(true)}
                    onClose={() => setManageOpen(false)}
                  />
                </div>
              )}
            </div>
          </div>
          <SessionList projectId={project.id} />
        </div>
      )}
      {editing && <EditProjectDialog project={project} onClose={() => setEditing(false)} />}
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
