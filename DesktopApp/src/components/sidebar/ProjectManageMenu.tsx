import { Icon } from '../shared/Icon';

type Props = { onEdit: () => void; onDelete: () => void; onClose: () => void };

export function ProjectManageMenu({ onEdit, onDelete, onClose }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        onClick={() => { onEdit(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
        <span>Edytuj</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onDelete(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-danger hover:bg-danger/10"
      >
        <Icon name="trash" className="w-3 h-3" strokeWidth={2} />
        <span>Usuń</span>
      </button>
    </div>
  );
}
