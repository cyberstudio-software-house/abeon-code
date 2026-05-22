export function AttachmentBlock({ kind, name }: { kind: string; name: string }) {
  return (
    <div className="my-1 text-xs text-muted text-center">
      📎 {kind}: <span className="font-mono">{name}</span>
    </div>
  );
}
