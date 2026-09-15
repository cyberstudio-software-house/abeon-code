import type { HistoryBlock } from '../types';

export function mergeHistoryWindow(current: HistoryBlock[], incoming: HistoryBlock[]): HistoryBlock[] {
  if (incoming.length === 0) return current;
  const currentIndex = new Map(current.map((block, index) => [block.uuid, index]));
  const overlap = incoming.find(block => currentIndex.has(block.uuid));
  if (!overlap) return [...current, ...incoming];
  return [...current.slice(0, currentIndex.get(overlap.uuid)), ...incoming];
}

export function prependHistoryPage(current: HistoryBlock[], older: HistoryBlock[]): HistoryBlock[] {
  const currentIds = new Set(current.map(block => block.uuid));
  return [...older.filter(block => !currentIds.has(block.uuid)), ...current];
}
