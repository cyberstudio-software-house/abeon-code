export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="shrink-0 font-sans text-[10.5px] leading-none text-icon px-[5px] py-px border border-border-strong rounded-[5px]">
      {children}
    </kbd>
  );
}
