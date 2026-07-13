import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { DetachedShell } from './components/layout/DetachedShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { useStore } from './store';
import { installMiddleClickPasteGuard } from './lib/middleClickPasteGuard';
import { parseWindowMode } from './lib/windowMode';

const windowMode = parseWindowMode(window.location.search);

export default function App() {
  const settingsOpen = useStore(s => s.settingsOpen);

  useEffect(() => installMiddleClickPasteGuard(), []);

  return (
    <ThemeProvider>
      <ErrorBoundary>
        {windowMode ? <DetachedShell mode={windowMode} /> : <AppShell />}
      </ErrorBoundary>
      {!windowMode && settingsOpen && <SettingsDialog />}
      <ErrorBoundary>
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            style: { borderRadius: 0, fontFamily: "'Geist', sans-serif" },
          }}
        />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
