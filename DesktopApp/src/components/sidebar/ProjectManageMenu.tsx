import { Icon } from '../shared/Icon';

type Props = { onSummary: () => void; onEdit: () => void; onDelete: () => void; onClose: () => void };

export function ProjectManageMenu({ onSummary, onEdit, onDelete, onClose }: Props) {
  return (
    <div role="menu">
      <button
        role="menuitem"
        onClick={() => { onSummary(); onClose(); }}
        className="menu-item"
      >
        <Icon name="chart" className="w-3 h-3" strokeWidth={2} />
        <span>Podsumowanie</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onEdit(); onClose(); }}
        className="menu-item"
      >
        <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
        <span>Edytuj</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onDelete(); onClose(); }}
        className="menu-item text-danger hover:bg-danger/10"
      >
        <Icon name="trash" className="w-3 h-3" strokeWidth={2} />
        <span>Usuń</span>
      </button>
    </div>
  );
}
