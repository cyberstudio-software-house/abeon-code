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
        className="w-full text-left px-2 py-1 rounded flex items-center gap-1 hover:bg-bg-elev-2"
      >
        <span className="text-muted text-xs">{expanded ? '▾' : '▸'}</span>
        <span className="truncate">{project.name}</span>
      </button>
      {expanded && <SessionList projectId={project.id} />}
    </li>
  );
}
