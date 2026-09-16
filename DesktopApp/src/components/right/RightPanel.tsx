import { ActionsSection } from './ActionsSection';
import { ClickUpSection } from './ClickUpSection';
import { GitSection } from './GitSection';
import { ProjectToolbar } from './ProjectToolbar';
import { UsageSection } from './UsageSection';
export function RightPanel() {
  return (
    <aside className="h-full bg-bg p-4 text-[13px] flex flex-col gap-4">
      <ProjectToolbar />
      <div className="border-t border-border" />
      <ActionsSection />
      <div className="border-t border-border" />
      <ClickUpSection />
      <div className="border-t border-border" />
      <GitSection />
      <div className="border-t border-border" />
      <UsageSection />
    </aside>
  );
}
