import type { Provider } from '../types';
import type { IconName } from '../components/shared/Icon';

export const ALL_PROVIDERS: Provider[] = ['claude', 'codex', 'opencode'];

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export const PROVIDER_ICON: Record<Provider, IconName> = {
  claude: 'claudeLogo',
  codex: 'openaiLogo',
  opencode: 'opencodeLogo',
};

export function isProvider(value: unknown): value is Provider {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}
