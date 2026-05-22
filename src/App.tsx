import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { useStore } from './store';

export default function App() {
  const settingsOpen = useStore(s => s.settingsOpen);

  return (
    <ThemeProvider>
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
      {settingsOpen && <SettingsDialog />}
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
