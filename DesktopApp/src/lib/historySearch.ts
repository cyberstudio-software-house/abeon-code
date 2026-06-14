import type { HistoryBlock } from '../types';

export function blockSearchText(block: HistoryBlock): string {
  switch (block.kind) {
    case 'userText':
    case 'assistantText':
    case 'assistantThinking':
      return block.text;
    case 'toolUse': {
      const raw = typeof block.raw_input === 'string'
        ? block.raw_input
        : block.raw_input != null
          ? JSON.stringify(block.raw_input)
          : '';
      return `${block.name} ${block.input_summary} ${raw}`;
    }
    case 'toolResult':
      return block.content;
    case 'attachment':
      return block.name;
    case 'system':
      return block.message;
  }
}
