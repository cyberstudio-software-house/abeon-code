export function formatClock(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString('pl-PL', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
