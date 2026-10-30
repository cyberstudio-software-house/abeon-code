import type { HistoryBlock } from '../types';

export type ToolStatus = 'pending' | 'done' | 'error';

export function pairToolStatuses(blocks: HistoryBlock[]): Map<number, ToolStatus> {
  const statuses = new Map<number, ToolStatus>();
  const pending: number[] = [];
  blocks.forEach((block, index) => {
    if (block.kind === 'toolUse') {
      statuses.set(index, 'pending');
      pending.push(index);
    } else if (block.kind === 'toolResult') {
      const toolIndex = pending.shift();
      if (toolIndex !== undefined) statuses.set(toolIndex, block.is_error ? 'error' : 'done');
    }
  });
  return statuses;
}
