import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';

export default function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <AppShell />
      </ErrorBoundary>
      <ErrorBoundary>
        <Toaster richColors position="bottom-right" />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
