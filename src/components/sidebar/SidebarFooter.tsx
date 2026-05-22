import { Icon } from '../shared/Icon';

export function SidebarFooter() {
  return (
    <div className="border-t border-border px-1 py-2.5 flex items-center gap-2.5">
      <div className="w-6 h-6 rounded-full bg-bg-elev-2 text-fg-secondary flex items-center justify-center text-[11px] font-semibold">
        D
      </div>
      <div className="leading-tight">
        <div className="text-[12px] font-medium">Developer</div>
        <div className="font-mono text-[10px] text-muted">claude-sonnet-4-5</div>
      </div>
      <button className="ml-auto text-muted hover:text-fg transition-colors" aria-label="Ustawienia">
        <Icon name="settings" className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
