import { Icon, type IconName } from './Icon';

type Tone = 'default' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

type Props = {
  icon: IconName;
  label: string;
  onClick?: () => void;
  tone?: Tone;
  size?: Size;
  loading?: boolean;
};

const sizes: Record<Size, string> = { sm: 'w-6 h-6', md: 'w-7 h-7', lg: 'w-8 h-8' };
const tones: Record<Tone, string> = {
  default: 'border-border bg-bg-elev text-fg-secondary hover:text-fg hover:bg-bg-elev-2',
  ghost:   'border-transparent bg-transparent text-muted hover:text-fg hover:bg-bg-elev-2',
};

export function IconBtn({ icon, label, onClick, tone = 'default', size = 'md', loading = false }: Props) {
  return (
    <button
      onClick={loading ? undefined : onClick}
      aria-label={label}
      aria-busy={loading || undefined}
      title={label}
      disabled={loading}
      className={`inline-flex items-center justify-center border transition-colors ${sizes[size]} ${tones[tone]} ${loading ? 'cursor-wait opacity-70' : ''}`}
    >
      <Icon
        name={loading ? 'spinner' : icon}
        className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
      />
    </button>
  );
}
