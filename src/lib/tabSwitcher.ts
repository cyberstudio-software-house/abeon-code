import type { Tab } from '../store/tabsSlice';

export function orderTabsByMru(tabs: Tab[], mruOrder: string[]): Tab[] {
  const byId = new Map(tabs.map(t => [t.id, t] as const));
  const seen = new Set<string>();
  const ordered: Tab[] = [];
  for (const id of mruOrder) {
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      ordered.push(t);
      seen.add(id);
    }
  }
  for (const t of tabs) {
    if (!seen.has(t.id)) {
      ordered.push(t);
      seen.add(t.id);
    }
  }
  return ordered;
}

export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
