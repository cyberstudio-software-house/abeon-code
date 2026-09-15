import { describe, expect, it } from 'vitest';
import type { HistoryBlock } from '../types';
import { mergeHistoryWindow, prependHistoryPage } from './historySync';

const text = (uuid: string, value: string): HistoryBlock => ({
  kind: 'assistantText',
  uuid,
  timestamp: 0,
  text: value,
});

describe('mergeHistoryWindow', () => {
  it('replaces the overlapping tail and keeps loaded older blocks', () => {
    const current = [text('old', 'old'), text('stream', 'partial')];
    const incoming = [text('stream', 'complete'), text('next', 'done')];
    expect(mergeHistoryWindow(current, incoming)).toEqual([
      text('old', 'old'),
      text('stream', 'complete'),
      text('next', 'done'),
    ]);
  });

  it('appends a window without overlap', () => {
    expect(mergeHistoryWindow([text('old', 'old')], [text('new', 'new')])).toEqual([
      text('old', 'old'),
      text('new', 'new'),
    ]);
  });

  it('returns the same reference for an empty incoming window', () => {
    const current = [text('old', 'old')];
    expect(mergeHistoryWindow(current, [])).toBe(current);
  });

  it('replaces the full window when the first block overlaps', () => {
    expect(mergeHistoryWindow(
      [text('first', 'partial'), text('stale', 'stale')],
      [text('first', 'complete')],
    )).toEqual([text('first', 'complete')]);
  });
});

describe('prependHistoryPage', () => {
  it('keeps the latest tail while prepending an older page without duplicates', () => {
    const current = [text('first', 'current'), text('tail', 'latest')];
    const older = [text('old', 'older'), text('first', 'stale')];

    expect(prependHistoryPage(current, older)).toEqual([
      text('old', 'older'),
      text('first', 'current'),
      text('tail', 'latest'),
    ]);
  });
});
