export const APP_NAME = 'AbeonCode';
const MAX_TITLE_LENGTH = 40;

/**
 * Builds the OS window title from the active tab's title.
 * No active tab (or an empty title) -> just the app name.
 * Otherwise: "<title> — AbeonCode", with the title truncated to
 * MAX_TITLE_LENGTH chars + "…" when it is longer.
 */
export function formatWindowTitle(tabTitle: string | null): string {
  const trimmed = tabTitle?.trim() ?? '';
  if (!trimmed) return APP_NAME;
  const title = trimmed.length > MAX_TITLE_LENGTH
    ? `${trimmed.slice(0, MAX_TITLE_LENGTH)}…`
    : trimmed;
  return `${title} — ${APP_NAME}`;
}
