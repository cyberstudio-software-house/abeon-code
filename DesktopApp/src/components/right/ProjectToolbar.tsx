import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import { Icon, type IconName } from '../shared/Icon';
import { toast } from 'sonner';

const buttonClassName = 'flex h-[30px] min-w-0 items-center justify-center gap-1.5 rounded-[7px] text-[12px] text-icon transition-colors hover:bg-bg-elev-2 hover:text-fg-strong';

type ToolbarButtonProps = {
  icon: IconName;
  label: string;
  onClick: () => void;
};

function ToolbarButton({ icon, label, onClick }: ToolbarButtonProps) {
  return (
    <button type="button" className={buttonClassName} onClick={onClick}>
      <Icon name={icon} className="h-[13px] w-[13px] shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function ProjectToolbar() {
  const tabs = useStore(state => state.tabs);
  const activeTabId = useStore(state => state.activeTabId);
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const projects = useStore(state => state.projects);
  const project = projectId != null ? projects.find(item => item.id === projectId) ?? null : null;
  const openTerminal = useStore(state => state.openTerminal);

  if (!project) return null;

  const openEditor = () => {
    void tauri.openProjectInEditor(project.path).catch(() => {
      toast.error('Nie udało się otworzyć projektu w edytorze');
    });
  };

  return (
    <div role="group" aria-label="Otwórz projekt w" className="grid shrink-0 grid-cols-2 gap-0.5 rounded-[10px] border border-border bg-sunken p-[3px]">
      <ToolbarButton
        icon="terminal"
        label="Terminal"
        onClick={() => openTerminal(project.id, { toggle: false })}
      />
      <ToolbarButton
        icon="code"
        label="Edytor"
        onClick={openEditor}
      />
    </div>
  );
}
