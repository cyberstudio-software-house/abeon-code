import { describe, it, expect } from 'vitest';
import { formatTokens, formatCost } from './formatUsage';

describe('formatTokens', () => {
  it('formats small numbers verbatim', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
  });
  it('formats thousands with k', () => {
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(12000)).toBe('12k');
  });
  it('formats millions with M', () => {
    expect(formatTokens(2_300_000)).toBe('2.3M');
  });
});

describe('formatCost', () => {
  it('uses cents precision under a dollar', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.4231)).toBe('$0.42');
  });
  it('keeps two decimals above a dollar', () => {
    expect(formatCost(12.5)).toBe('$12.50');
  });
});
