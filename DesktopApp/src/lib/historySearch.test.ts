import { describe, it, expect } from 'vitest';
import { blockSearchText } from './historySearch';
import type { HistoryBlock } from '../types';

const base = { uuid: 'u', timestamp: 0 };

describe('blockSearchText', () => {
  it('returns text for userText, assistantText, assistantThinking', () => {
    expect(blockSearchText({ ...base, kind: 'userText', text: 'Hello user' })).toBe('Hello user');
    expect(blockSearchText({ ...base, kind: 'assistantText', text: 'Hi there' })).toBe('Hi there');
    expect(blockSearchText({ ...base, kind: 'assistantThinking', text: 'pondering' })).toBe('pondering');
  });

  it('combines name, input_summary and raw_input for toolUse', () => {
    const block: HistoryBlock = { ...base, kind: 'toolUse', name: 'Read', input_summary: 'file.ts', raw_input: { path: '/x/y' } };
    const text = blockSearchText(block);
    expect(text).toContain('Read');
    expect(text).toContain('file.ts');
    expect(text).toContain('/x/y');
  });

  it('handles string raw_input without double-quoting', () => {
    const block: HistoryBlock = { ...base, kind: 'toolUse', name: 'Bash', input_summary: 'ls', raw_input: 'ls -la' };
    expect(blockSearchText(block)).toContain('ls -la');
  });

  it('returns content for toolResult, name for attachment, message for system', () => {
    expect(blockSearchText({ ...base, kind: 'toolResult', content: 'output', is_error: false })).toBe('output');
    expect(blockSearchText({ ...base, kind: 'attachment', attachmentKind: 'image', name: 'pic.png' })).toBe('pic.png');
    expect(blockSearchText({ ...base, kind: 'system', subtype: 'info', message: 'system note' })).toBe('system note');
  });

  it('does not inject quote characters for null raw_input', () => {
    const block: HistoryBlock = { ...base, kind: 'toolUse', name: 'X', input_summary: 'y', raw_input: null };
    expect(blockSearchText(block)).not.toContain('"');
  });
});
