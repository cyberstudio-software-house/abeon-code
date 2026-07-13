import { Icon } from '../shared/Icon';

type Props = {
  onDetach: () => void;
  onCloseMenu: () => void;
};

export function GroupContextMenu({ onDetach, onCloseMenu }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        onClick={() => { onDetach(); onCloseMenu(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="external-link" className="w-3 h-3" strokeWidth={2} />
        <span>Wydziel do nowego okna</span>
      </button>
    </div>
  );
}
