import { useStore } from '../../store';
import type { Project } from '../../types';
import { SessionList } from './SessionList';

type Props = { project: Project };

export function ProjectItem({ project }: Props) {
  const expanded = useStore(s => s.expandedProjectIds.has(project.id));
  const toggle = useStore(s => s.toggleProjectExpanded);
  return (
    <li>
      <button
        onClick={() => toggle(project.id)}
        className="w-full text-left px-2 py-1.5 flex items-center gap-2 hover:bg-bg-elev"
      >
        <svg className={`w-2.5 h-2.5 text-fg transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-semibold truncate">{project.name}</div>
          <div className="text-[10px] text-muted truncate">{project.path}</div>
        </div>
      </button>
      {expanded && <SessionList projectId={project.id} />}
    </li>
  );
}
