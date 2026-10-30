export function SystemBlock({ subtype, message }: { subtype: string; message: string }) {
  return (
    <div className="flex items-center gap-2 px-0.5 py-0.5 text-[11.5px] text-muted">
      <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-faint" />
      <span className="font-mono">{subtype}</span>
      {message && (
        <>
          <span aria-hidden="true">·</span>
          <span className="truncate">{message}</span>
        </>
      )}
    </div>
  );
}
