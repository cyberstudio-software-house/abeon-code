import { Icon } from '../../shared/Icon';

export function AttachmentBlock({ kind, name }: { kind: string; name: string }) {
  return (
    <div className="my-0.5 flex h-8 items-center gap-2.5 rounded-[8px] border border-border bg-console px-2.5 text-[12.5px] text-muted">
      <Icon name="file" className="h-[13px] w-[13px] shrink-0 text-icon" />
      <span>{kind}:</span>
      <span className="min-w-0 truncate font-mono text-[11.5px] text-fg-secondary">{name}</span>
    </div>
  );
}
