import { Icon } from '../../shared/Icon';

export function AttachmentBlock({ kind, name }: { kind: string; name: string }) {
  return (
    <div className="my-2 ml-16 inline-flex items-center gap-2.5 text-[12px] text-muted bg-bg-elev border border-border/30 rounded-md px-3 py-1.5">
      <Icon name="file" className="w-3.5 h-3.5 shrink-0" />
      <span>{kind}:</span>
      <span className="font-mono text-fg-secondary">{name}</span>
    </div>
  );
}
