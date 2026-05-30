import { useEffect, useState } from 'react';
import { Icon } from '../shared/Icon';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import { getModelDisplayLabel } from '../../lib/models';
import type { GitUser } from '../../types';

export function SidebarFooter() {
  const [user, setUser] = useState<GitUser | null>(null);
  useEffect(() => { tauri.getGitUser().then(setUser).catch(() => {}); }, []);

  const displayName = useStore(s => s.displayName);
  const defaultModelId = useStore(s => s.defaultModelId);
  const customModels = useStore(s => s.customModels);
  const openSettings = useStore(s => s.openSettings);

  const initials = displayName
    ? displayName.slice(0, 1).toUpperCase()
    : (user?.initials ?? 'D');
  const name = displayName || (user?.name ?? 'Developer');
  const modelLabel = getModelDisplayLabel(defaultModelId, customModels);

  return (
    <div className="border-t border-border px-1 py-2.5 flex items-center gap-2.5">
      <div className="w-6 h-6 rounded-full bg-bg-elev-2 text-fg-secondary flex items-center justify-center text-[11px] font-semibold">
        {initials}
      </div>
      <div className="leading-tight">
        <div className="text-[12px] font-medium">{name}</div>
        <div className="font-mono text-[10px] text-muted">{modelLabel}</div>
      </div>
      <button
        onClick={openSettings}
        className="ml-auto text-muted hover:text-fg transition-colors"
        aria-label="Ustawienia"
      >
        <Icon name="settings" className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
