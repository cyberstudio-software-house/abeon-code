export function redirectTarget(status: 'paired' | 'unpaired'): string {
  return status === 'paired' ? '/(tabs)/sessions' : '/pair';
}
