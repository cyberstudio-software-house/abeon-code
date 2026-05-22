import { Icon, type IconName } from './Icon';

type Tone = 'default' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

type Props = {
  icon: IconName;
  label: string;
  onClick?: () => void;
  tone?: Tone;
  size?: Size;
};

const sizes: Record<Size, string> = { sm: 'w-6 h-6', md: 'w-7 h-7', lg: 'w-8 h-8' };
const tones: Record<Tone, string> = {
  default: 'border-border bg-bg-elev text-fg-secondary hover:text-fg hover:bg-bg-elev-2',
  ghost:   'border-transparent bg-transparent text-muted hover:text-fg hover:bg-bg-elev-2',
};

export function IconBtn({ icon, label, onClick, tone = 'default', size = 'md' }: Props) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center border transition-colors ${sizes[size]} ${tones[tone]}`}
    >
      <Icon name={icon} className="w-3.5 h-3.5" />
    </button>
  );
}
