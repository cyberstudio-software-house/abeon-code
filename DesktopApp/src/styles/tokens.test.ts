import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, './globals.css'), 'utf8');

const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));

it.each([
  ['bg', '#0b0c0e'], ['bg-elev', '#111215'], ['console', '#0f1012'], ['accent', '#f0b44c'],
  ['accent-fg', '#1b1405'], ['info', '#8fb3f9'], ['pink', '#e58fb4'], ['border-focus', '#2e3136'],
])('defines the dark %s token', (name, value) => {
  expect(darkBlock).toContain(`--color-${name}: ${value};`);
});

it('loads no fonts from the network', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  expect(html).not.toContain('fonts.googleapis.com');
});

it('defines the 1.6 s activity pulse', () => {
  expect(css).toMatch(/\.activity-pulse\s*\{[^}]*1\.6s/);
});
