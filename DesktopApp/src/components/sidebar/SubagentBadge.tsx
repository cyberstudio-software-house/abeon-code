type Props = {
  running: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
};

export function SubagentBadge({ running, total, expanded, onToggle }: Props) {
  if (total === 0) return null;
  const tone = running > 0 ? 'text-accent' : 'text-muted';
  const label = running > 0
    ? `Pracuje ${running} z ${total} agentów`
    : `${total} zakończonych agentów`;

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      onClick={e => { e.stopPropagation(); onToggle(); }}
      className={`shrink-0 font-mono text-[10px] px-1 rounded hover:bg-bg-elev ${tone}`}
    >
      🤖 {running > 0 ? running : total}
    </button>
  );
}
