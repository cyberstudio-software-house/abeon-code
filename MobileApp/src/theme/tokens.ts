export type ThemeMode = 'light' | 'dark';
export interface Tokens {
  bg: string; bgElev: string; bgElev2: string;
  fg: string; fg2: string; muted: string; border: string;
  accent: string; accent2: string; accentFg: string;
  danger: string; success: string;
}
const light: Tokens = {
  bg: '#f7f3ec', bgElev: '#fffdf9', bgElev2: '#efe9df',
  fg: '#201d18', fg2: '#5a564d', muted: '#9a9388', border: '#e7e0d3',
  accent: '#b07c2e', accent2: '#d6a44c', accentFg: '#ffffff',
  danger: '#c14a3d', success: '#3f9d44',
};
const dark: Tokens = {
  bg: '#14110d', bgElev: '#1e1a14', bgElev2: '#28231b',
  fg: '#efe8da', fg2: '#b0a896', muted: '#6f685a', border: '#332d23',
  accent: '#e0ad57', accent2: '#c98f3a', accentFg: '#14110d',
  danger: '#ec6a5e', success: '#61c454',
};
export function resolveTokens(mode: ThemeMode): Tokens {
  return mode === 'dark' ? dark : light;
}
