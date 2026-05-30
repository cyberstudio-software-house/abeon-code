export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] leading-none text-muted px-1.5 py-0.5 border border-border rounded-sm">
      {children}
    </span>
  );
}
