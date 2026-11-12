import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';

const MENU_WIDTH = 208;
const MENU_HEIGHT = 84;

export type FileEntryMenuTarget = { x: number; y: number; path: string };

type Props = {
  target: FileEntryMenuTarget;
  onClose: () => void;
};

export function FileEntryMenu({ target, onClose }: Props) {
  const activeAgentPtyId = useStore(state => state.activeAgentPtyId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const copyPath = async () => {
    onClose();
    try {
      await tauri.writeClipboardText(target.path);
    } catch {
      toast.error('Nie udało się skopiować ścieżki');
    }
  };

  const insertPath = async () => {
    if (!activeAgentPtyId) return;
    onClose();
    try {
      await tauri.ptyWrite(activeAgentPtyId, btoa(unescape(encodeURIComponent(`${target.path} `))));
    } catch {
      toast.error('Nie udało się wstawić ścieżki do sesji');
    }
  };

  const left = Math.max(0, Math.min(target.x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(0, Math.min(target.y, window.innerHeight - MENU_HEIGHT - 8));

  return (
    <div ref={ref} className="fixed z-50" style={{ left, top }}>
      <div role="menu" className="menu-panel" style={{ width: MENU_WIDTH }}>
        <button role="menuitem" type="button" className="menu-item" onClick={() => void copyPath()}>
          <Icon name="copy" className="h-3 w-3" strokeWidth={2} />
          <span>Kopiuj ścieżkę</span>
        </button>
        <button
          role="menuitem"
          type="button"
          className="menu-item"
          disabled={!activeAgentPtyId}
          title={activeAgentPtyId ? undefined : 'Brak aktywnej sesji'}
          onClick={() => void insertPath()}
        >
          <Icon name="terminal" className="h-3 w-3" strokeWidth={2} />
          <span>Wstaw ścieżkę do sesji</span>
        </button>
      </div>
    </div>
  );
}
