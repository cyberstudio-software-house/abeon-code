import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { DetachedShell } from './components/layout/DetachedShell';
import { NotesShell } from './components/notes/NotesShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { installMiddleClickPasteGuard } from './lib/middleClickPasteGuard';
import { parseWindowMode } from './lib/windowMode';

const windowMode = parseWindowMode(window.location.search);

export default function App() {
  useEffect(() => installMiddleClickPasteGuard(), []);

  return (
    <ThemeProvider>
      <ErrorBoundary>
        {windowMode?.view === 'notes'
          ? <NotesShell projectId={windowMode.projectId} />
          : windowMode
            ? <DetachedShell mode={windowMode} />
            : <AppShell />}
      </ErrorBoundary>
      <ErrorBoundary>
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            style: { borderRadius: 0, fontFamily: "'Geist Sans', ui-sans-serif, system-ui, sans-serif" },
          }}
        />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
