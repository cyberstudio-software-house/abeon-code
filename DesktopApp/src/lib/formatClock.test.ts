import { describe, it, expect } from 'vitest';
import { formatClock } from './formatClock';

describe('formatClock', () => {
  it('formats a local time as a 24 hour HH:MM string', () => {
    expect(formatClock(new Date(2026, 9, 29, 18, 42).getTime())).toBe('18:42');
  });

  it('pads single digit hours and minutes', () => {
    expect(formatClock(new Date(2026, 9, 29, 7, 5).getTime())).toBe('07:05');
  });
});
