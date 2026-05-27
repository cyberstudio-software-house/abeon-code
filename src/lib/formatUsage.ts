export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
