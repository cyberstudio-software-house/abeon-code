import { useStore } from '../../store';
import { FilesPanel } from '../files/FilesPanel';
import { NotesPanel } from '../notes/NotesPanel';
import { ActionsSection } from './ActionsSection';
import { ClickUpSection } from './ClickUpSection';
import { GitSection } from './GitSection';
import { ProjectToolbar } from './ProjectToolbar';
import { UsageSection } from './UsageSection';

export function RightPanel({ detached = false }: { detached?: boolean }) {
  const notesPanelOpen = useStore(state => state.notesPanelOpen);
  const filesPanelOpen = useStore(state => state.filesPanelOpen);
  const panelOpen = notesPanelOpen || filesPanelOpen;

  return (
    <aside className="h-full bg-transparent pl-1.5 pr-1 text-[13px] flex flex-col gap-5">
      {notesPanelOpen && <NotesPanel />}
      {filesPanelOpen && <FilesPanel />}
      <div hidden={panelOpen} inert={panelOpen} className="flex min-h-0 flex-1 flex-col gap-5">
        <ProjectToolbar />
        <ActionsSection />
        <ClickUpSection detached={detached} />
        <GitSection />
        <UsageSection />
      </div>
    </aside>
  );
}
