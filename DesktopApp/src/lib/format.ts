export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000, h = 60 * min, d = 24 * h;
  if (diff < min) return 'przed chwilą';
  if (diff < h) return `${Math.floor(diff / min)} min temu`;
  if (diff < d) return `${Math.floor(diff / h)} h temu`;
  if (diff < 7 * d) return `${Math.floor(diff / d)} dni temu`;
  return new Date(ms).toLocaleDateString('pl-PL');
}
