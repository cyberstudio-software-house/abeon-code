import { redirectTarget } from '@/src/lib/nav';

test('paired users go to the sessions tab', () => {
  expect(redirectTarget('paired')).toBe('/(tabs)/sessions');
});
test('unpaired users go to pairing', () => {
  expect(redirectTarget('unpaired')).toBe('/pair');
});
