export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="kbd font-mono">
      {children}
    </kbd>
  );
}
