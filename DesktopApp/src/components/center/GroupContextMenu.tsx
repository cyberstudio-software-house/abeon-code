import { Icon } from '../shared/Icon';

type Props = {
  onDetach: () => void;
  onCloseMenu: () => void;
};

export function GroupContextMenu({ onDetach, onCloseMenu }: Props) {
  return (
    <div role="menu">
      <button
        role="menuitem"
        onClick={() => { onDetach(); onCloseMenu(); }}
        className="menu-item"
      >
        <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
        <span>Wydziel do nowego okna</span>
      </button>
    </div>
  );
}
