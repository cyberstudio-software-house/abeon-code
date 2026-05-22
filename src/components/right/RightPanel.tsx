import { ActionsSection } from './ActionsSection';
import { GitSection } from './GitSection';
export function RightPanel() {
  return (
    <aside className="h-full bg-bg p-4 text-[13px] flex flex-col gap-4">
      <ActionsSection />
      <div className="border-t border-border" />
      <GitSection />
    </aside>
  );
}
