import { useStore } from '../../store';
import type { Project } from '../../types';
import { SessionList } from './SessionList';
import { Icon } from '../shared/Icon';

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
        <Icon name="chevR" className={`w-2.5 h-2.5 text-fg transition-transform ${expanded ? 'rotate-90' : ''}`} strokeWidth={2.5} />
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-semibold truncate">{project.name}</div>
          <div className="text-[10px] text-muted truncate">{project.path}</div>
        </div>
        <span className="text-[10px] text-muted shrink-0">...</span>
      </button>
      {expanded && <SessionList projectId={project.id} />}
    </li>
  );
}
