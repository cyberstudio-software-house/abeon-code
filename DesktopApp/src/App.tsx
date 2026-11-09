import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { DetachedShell } from './components/layout/DetachedShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { installMiddleClickPasteGuard } from './lib/middleClickPasteGuard';
import { parseWindowMode } from './lib/windowMode';

const windowMode = parseWindowMode(window.location.search);

export default function App() {
  useEffect(() => installMiddleClickPasteGuard(), []);

  return (
    <ThemeProvider>
      <ErrorBoundary>
        {windowMode ? <DetachedShell mode={windowMode} /> : <AppShell />}
      </ErrorBoundary>
      <ErrorBoundary>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--color-bg-elev)',
              color: 'var(--color-fg)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              fontFamily: "'Geist Sans', ui-sans-serif, system-ui, sans-serif",
            },
          }}
        />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
