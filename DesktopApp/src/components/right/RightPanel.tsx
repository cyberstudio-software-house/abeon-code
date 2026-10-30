import { ActionsSection } from './ActionsSection';
import { ClickUpSection } from './ClickUpSection';
import { GitSection } from './GitSection';
import { ProjectToolbar } from './ProjectToolbar';
import { UsageSection } from './UsageSection';

export function RightPanel({ detached = false }: { detached?: boolean }) {
  return (
    <aside className="h-full bg-transparent pl-1.5 pr-1 text-[13px] flex flex-col gap-5">
      <ProjectToolbar />
      <ActionsSection />
      <ClickUpSection detached={detached} />
      <GitSection />
      <UsageSection />
    </aside>
  );
}
