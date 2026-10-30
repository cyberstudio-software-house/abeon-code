import { describe, it, expect } from 'vitest';
import type { HistoryBlock } from '../types';
import { pairToolStatuses } from './toolStatus';

const use = (uuid: string): HistoryBlock => ({
  kind: 'toolUse', uuid, timestamp: 1, name: 'Bash', input_summary: 'ls', raw_input: {},
});
const result = (uuid: string, isError = false): HistoryBlock => ({
  kind: 'toolResult', uuid, timestamp: 1, content: 'ok', is_error: isError,
});
const system = (uuid: string): HistoryBlock => ({
  kind: 'system', uuid, timestamp: 1, subtype: 'hook', message: '',
});

describe('pairToolStatuses', () => {
  it('marks the first of two parallel tool calls done after one result', () => {
    const statuses = pairToolStatuses([use('a'), use('b'), result('r1')]);
    expect(statuses.get(0)).toBe('done');
    expect(statuses.get(1)).toBe('pending');
  });

  it('marks a tool whose result is an error as error', () => {
    const statuses = pairToolStatuses([use('a'), result('r1', true)]);
    expect(statuses.get(0)).toBe('error');
  });

  it('keeps a tool pending when only a system block follows it', () => {
    const statuses = pairToolStatuses([use('a'), system('s')]);
    expect(statuses.get(0)).toBe('pending');
  });

  it('pairs a result after an interleaved system line', () => {
    const statuses = pairToolStatuses([use('a'), system('s'), result('r1')]);
    expect(statuses.get(0)).toBe('done');
  });

  it('ignores a result with no pending tool call', () => {
    expect(pairToolStatuses([result('r1')]).size).toBe(0);
  });
});
