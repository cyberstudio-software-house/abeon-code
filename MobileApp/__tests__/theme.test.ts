import { resolveTokens } from '@/src/theme/tokens';

test('light tokens use warm paper + gold', () => {
  const t = resolveTokens('light');
  expect(t.bg).toBe('#f7f3ec');
  expect(t.accent).toBe('#b07c2e');
});

test('dark tokens use near-black + brighter gold', () => {
  const t = resolveTokens('dark');
  expect(t.bg).toBe('#14110d');
  expect(t.accent).toBe('#e0ad57');
});
