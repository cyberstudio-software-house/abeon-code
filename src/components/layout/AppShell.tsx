import { ResizableSplit } from './ResizableSplit';
import { Sidebar } from '../sidebar/Sidebar';
import { CenterPanel } from '../center/CenterPanel';
import { RightPanel } from '../right/RightPanel';
import { useStore } from '../../store';

export function AppShell() {
  const leftWidth = useStore(s => s.leftWidth);
  const rightWidth = useStore(s => s.rightWidth);
  const setLeftWidth = useStore(s => s.setLeftWidth);
  const setRightWidth = useStore(s => s.setRightWidth);

  return (
    <div className="h-full w-full">
      <ResizableSplit
        leftWidth={leftWidth}
        minLeft={200}
        maxLeft={420}
        onResize={setLeftWidth}
        left={<Sidebar />}
        right={
          <ResizableSplit
            leftWidth={Math.max(0, window.innerWidth - leftWidth - rightWidth)}
            minLeft={300}
            maxLeft={window.innerWidth - leftWidth - 220}
            onResize={(w) => setRightWidth(Math.max(220, window.innerWidth - leftWidth - w))}
            left={<CenterPanel />}
            right={<RightPanel />}
          />
        }
      />
    </div>
  );
}
