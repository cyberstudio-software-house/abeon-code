import type { Provider } from '../types';
import type { IconName } from '../components/shared/Icon';

export const ALL_PROVIDERS: Provider[] = ['claude', 'codex'];

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const PROVIDER_ICON: Record<Provider, IconName> = {
  claude: 'claudeLogo',
  codex: 'openaiLogo',
};

export function isProvider(v: unknown): v is Provider {
  return v === 'claude' || v === 'codex';
}
