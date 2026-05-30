import { TabBar } from './TabBar';
import { TabContent } from './TabContent';

export function CenterPanel() {
  return (
    <main className="h-full bg-bg flex flex-col">
      <TabBar />
      <TabContent />
    </main>
  );
}
