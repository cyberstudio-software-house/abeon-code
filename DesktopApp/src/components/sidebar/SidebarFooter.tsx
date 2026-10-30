import { useEffect, useState } from 'react';
import { Icon } from '../shared/Icon';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { claudeModelLabel } from '../../lib/models';
import { initialsOf } from '../../lib/initials';
import type { GitUser } from '../../types';

export function SidebarFooter({ showSettingsButton = true }: { showSettingsButton?: boolean } = {}) {
  const [user, setUser] = useState<GitUser | null>(null);
  useEffect(() => { tauri.getGitUser().then(setUser).catch(() => {}); }, []);

  const displayName = useStore(s => s.displayName);
  const defaultModelId = useStore(s => s.defaultModelId);
  const customModels = useStore(useShallow(s => s.customModels));
  const openSettings = useStore(s => s.openSettings);

  const initials = initialsOf(displayName) || user?.initials || 'D';
  const name = displayName || (user?.name ?? 'Developer');
  const modelLabel = claudeModelLabel(defaultModelId, customModels);

  return (
    <div className="mt-auto border-t border-border-subtle px-1.5 py-2.5 flex items-center gap-2.5">
      <span aria-hidden="true" className="w-7 h-7 shrink-0 rounded-full bg-track text-fg-secondary grid place-items-center text-[11px] font-semibold">
        {initials}
      </span>
      <div className="flex-1 min-w-0 flex flex-col leading-tight">
        <span className="text-[13px] font-medium text-fg truncate">{name}</span>
        <span className="text-[11.5px] text-muted truncate">{modelLabel}</span>
      </div>
      {showSettingsButton && (
        <button
          onMouseDown={e => e.preventDefault()}
          onClick={() => openSettings()}
          className="w-[30px] h-[30px] shrink-0 rounded-[7px] grid place-items-center text-icon hover:bg-bg-elev-2 hover:text-fg transition-colors"
          aria-label="Ustawienia"
        >
          <Icon name="settings" className="w-[15px] h-[15px]" />
        </button>
      )}
    </div>
  );
}
