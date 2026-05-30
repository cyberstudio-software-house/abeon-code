import { Icon } from '../shared/Icon';

export function ReadOnlyPill() {
  return (
    <div className="inline-flex items-center gap-1.5 text-[11px] text-fg-secondary border border-border bg-bg-elev px-2.5 py-1 rounded-full font-mono">
      <Icon name="clock" className="w-[11px] h-[11px]" />
      Podgląd historii — sesja nie jest aktualnie uruchomiona
    </div>
  );
}
