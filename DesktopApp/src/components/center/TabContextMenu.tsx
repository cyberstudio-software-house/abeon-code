import { Icon } from '../shared/Icon';

type Props = {
  canDetach: boolean;
  canDetachGroup: boolean;
  onDetach: () => void;
  onDetachGroup: () => void;
  onRename: () => void;
  onClose: () => void;
  onCloseMenu: () => void;
};

export function TabContextMenu({ canDetach, canDetachGroup, onDetach, onDetachGroup, onRename, onClose, onCloseMenu }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        disabled={!canDetach}
        onClick={() => { if (!canDetach) return; onDetach(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default"
      >
        <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
        <span>Otwórz w nowym oknie</span>
      </button>
      {canDetachGroup && (
        <button
          role="menuitem"
          onClick={() => { onDetachGroup(); onCloseMenu(); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
        >
          <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
          <span>Wydziel projekt do nowego okna</span>
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => { onRename(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
        <span>Zmień nazwę</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onClose(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-danger hover:bg-danger/10"
      >
        <Icon name="close" className="w-3 h-3" strokeWidth={2} />
        <span>Zamknij</span>
      </button>
    </div>
  );
}
