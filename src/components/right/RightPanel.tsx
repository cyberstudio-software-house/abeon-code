import { ActionsSection } from './ActionsSection';
import { GitSection } from './GitSection';
export function RightPanel() {
  return (
    <aside className="h-full bg-bg-elev border-l border-border p-3 text-sm flex flex-col gap-3">
      <ActionsSection />
      <div className="border-t border-border" />
      <GitSection />
    </aside>
  );
}
