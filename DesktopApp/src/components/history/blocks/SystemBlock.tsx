export function SystemBlock({ subtype, message }: { subtype: string; message: string }) {
  return (
    <div className="my-1.5 ml-16 flex items-center gap-2 text-[11px] text-muted/60">
      <span className="w-1 h-1 rounded-full bg-muted/40 shrink-0" />
      <span className="font-mono">{subtype}</span>
      {message && (
        <>
          <span>·</span>
          <span className="truncate">{message}</span>
        </>
      )}
    </div>
  );
}
