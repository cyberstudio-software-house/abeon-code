import { Icon } from '../shared/Icon';

type Props = {
  canDetach: boolean;
  canDetachGroup: boolean;
  canRename: boolean;
  onDetach: () => void;
  onDetachGroup: () => void;
  onRename: () => void;
  onClose: () => void;
  onCloseMenu: () => void;
};

export function TabContextMenu({ canDetach, canDetachGroup, canRename, onDetach, onDetachGroup, onRename, onClose, onCloseMenu }: Props) {
  return (
    <div role="menu">
      <button
        role="menuitem"
        disabled={!canDetach}
        onClick={() => { if (!canDetach) return; onDetach(); onCloseMenu(); }}
        className="menu-item"
      >
        <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
        <span>Otwórz w nowym oknie</span>
      </button>
      {canDetachGroup && (
        <button
          role="menuitem"
          onClick={() => { onDetachGroup(); onCloseMenu(); }}
          className="menu-item"
        >
          <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
          <span>Wydziel projekt do nowego okna</span>
        </button>
      )}
      {canRename && (
        <button
          role="menuitem"
          onClick={() => { onRename(); onCloseMenu(); }}
          className="menu-item"
        >
          <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
          <span>Zmień nazwę</span>
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => { onClose(); onCloseMenu(); }}
        className="menu-item text-danger hover:bg-danger/10"
      >
        <Icon name="close" className="w-3 h-3" strokeWidth={2} />
        <span>Zamknij</span>
      </button>
    </div>
  );
}
