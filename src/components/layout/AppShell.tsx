import { useState } from 'react';
import { ResizableSplit } from './ResizableSplit';
import { Sidebar } from '../sidebar/Sidebar';
import { CenterPanel } from '../center/CenterPanel';
import { RightPanel } from '../right/RightPanel';

export function AppShell() {
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(300);

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
