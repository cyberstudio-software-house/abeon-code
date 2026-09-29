const MAX_TITLE_LENGTH = 40;
const FALLBACK_TITLE = 'New session';

export function promptTabTitle(prompt: string): string {
  const line = prompt.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!line) return FALLBACK_TITLE;
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH)}…` : line;
}
