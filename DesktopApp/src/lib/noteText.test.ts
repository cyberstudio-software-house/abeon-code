import { describe, it, expect } from 'vitest';
import { formatNoteDate, isBlankNote, noteTitle, notesListKey } from './noteText';

describe('noteText', () => {
  it('uses the first non-blank line as the title', () => {
    expect(noteTitle('\n  Klient chce CSV  \nreszta')).toBe('Klient chce CSV');
  });

  it('shortens long titles', () => {
    expect(noteTitle('a'.repeat(50))).toBe('a'.repeat(40) + '…');
    expect(noteTitle('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('titles blank content as an empty note', () => {
    expect(noteTitle(' \n ')).toBe('Pusta notatka');
  });

  it('detects blank content', () => {
    expect(isBlankNote(' \t\n')).toBe(true);
    expect(isBlankNote(' x ')).toBe(false);
  });

  it('builds list keys', () => {
    expect(notesListKey(4)).toBe('project:4');
    expect(notesListKey(null)).toBe('global');
  });

  it('formats dates relative to now', () => {
    const now = new Date(2026, 10, 9, 18, 0).getTime();
    expect(formatNoteDate(new Date(2026, 10, 9, 14, 32).getTime(), now)).toBe('dziś, 14:32');
    expect(formatNoteDate(new Date(2026, 10, 8, 16, 47).getTime(), now)).toBe('wczoraj, 16:47');
    expect(formatNoteDate(new Date(2026, 10, 3, 9, 12).getTime(), now)).toBe('3 lis, 09:12');
    expect(formatNoteDate(new Date(2025, 10, 3, 9, 12).getTime(), now)).toBe('3 lis 2025, 09:12');
  });

  it('treats yesterday across a month boundary', () => {
    const now = new Date(2026, 10, 1, 8, 0).getTime();
    expect(formatNoteDate(new Date(2026, 9, 31, 23, 5).getTime(), now)).toBe('wczoraj, 23:05');
  });
});
