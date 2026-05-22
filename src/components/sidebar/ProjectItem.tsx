import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import type { Project } from '../../types';
import { SessionList } from './SessionList';
import { Icon } from '../shared/Icon';
import { tauri } from '../../lib/tauri';

type Props = { project: Project };

export function ProjectItem({ project }: Props) {
  const expanded = useStore(s => s.expandedProjectIds.has(project.id));
  const toggle = useStore(s => s.toggleProjectExpanded);
  const openNew = useStore(s => s.openNewSessionTab);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    tauri.countSessions(project.id).then(setCount).catch(() => {});
  }, [project.id]);

  return (
    <li className="py-0.5">
      <button
        onClick={() => toggle(project.id)}
        className={`group w-full flex items-center gap-2 px-2.5 py-[7px] rounded-md text-left transition-colors ${
          expanded ? 'bg-bg-elev border border-border' : 'border border-transparent hover:bg-bg-elev'
        }`}
      >
        <Icon
          name="chevR"
          className={`w-2.5 h-2.5 text-fg-secondary transition-transform ${expanded ? 'rotate-90' : ''}`}
          strokeWidth={2.5}
        />
        <div className="min-w-0 flex-1">
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
          <button
            onClick={(e) => { e.stopPropagation(); openNew(project.id); }}
            className="w-full flex items-center gap-1.5 pr-2 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors"
          >
            <Icon name="plus" className="w-3 h-3" strokeWidth={2} />
            <span>New session</span>
          </button>
          <SessionList projectId={project.id} />
        </div>
      )}
    </li>
  );
}
