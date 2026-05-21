import { ThemeProvider } from './components/layout/ThemeProvider';

export default function App() {
  return (
    <ThemeProvider>
      <div className="h-full grid place-items-center text-fg">
        <span>AbeonCode shell</span>
      </div>
    </ThemeProvider>
  );
}
