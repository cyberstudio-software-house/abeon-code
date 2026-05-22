export function AttachmentBlock({ kind, name }: { kind: string; name: string }) {
  return (
    <div className="my-1 ml-14 text-[11px] text-muted">
      {kind}: <span className="font-mono text-fg-secondary">{name}</span>
    </div>
  );
}
