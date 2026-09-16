import { openNotesWindow } from '../../lib/openNotesWindow';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import { Icon, type IconName } from '../shared/Icon';
import { toast } from 'sonner';

const buttonClassName = 'flex min-w-0 flex-col items-center gap-1 rounded-md border border-border px-1 py-2 text-[10px] text-muted transition-colors hover:bg-bg-elev hover:text-fg';

type ToolbarButtonProps = {
  icon: IconName;
  label: string;
  ariaLabel: string;
  onClick: () => void;
};

function ToolbarButton({ icon, label, ariaLabel, onClick }: ToolbarButtonProps) {
  return (
    <button className={buttonClassName} aria-label={ariaLabel} onClick={onClick}>
      <Icon name={icon} className="h-3.5 w-3.5" />
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
  const openNewTerminalTab = useStore(state => state.openNewTerminalTab);

  if (!project) return null;

  const openEditor = () => {
    void tauri.openProjectInEditor(project.path).catch(() => {
      toast.error('Nie udało się otworzyć projektu w edytorze');
    });
  };

  const openNotes = () => {
    void openNotesWindow(project.id, project.name).catch(() => {
      toast.error('Nie udało się otworzyć okna notatek');
    });
  };

  return (
    <section className="grid grid-cols-3 gap-1.5 shrink-0">
      <ToolbarButton
        icon="terminal"
        label="Terminal"
        ariaLabel="Otwórz terminal"
        onClick={() => openNewTerminalTab(project.id)}
      />
      <ToolbarButton
        icon="code"
        label="Edytor"
        ariaLabel="Otwórz w edytorze"
        onClick={openEditor}
      />
      <ToolbarButton
        icon="notebook"
        label="Notatki"
        ariaLabel="Otwórz notatki"
        onClick={openNotes}
      />
    </section>
  );
}
