export const NOTE_TITLE_MAX = 40;

export type NotesListKey = 'global' | `project:${number}`;

const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

export function isBlankNote(content: string): boolean {
  return content.trim() === '';
}

export function noteTitle(content: string): string {
  const line = content.split('\n').map(l => l.trim()).find(l => l !== '');
  if (line === undefined) return 'Pusta notatka';
  return line.length > NOTE_TITLE_MAX ? `${line.slice(0, NOTE_TITLE_MAX)}…` : line;
}

export function notesListKey(projectId: number | null): NotesListKey {
  return projectId === null ? 'global' : `project:${projectId}`;
}

const two = (value: number) => String(value).padStart(2, '0');

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function formatNoteDate(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  if (sameDay(date, today)) return `dziś, ${time}`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(date, yesterday)) return `wczoraj, ${time}`;
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear() ? `${day}, ${time}` : `${day} ${date.getFullYear()}, ${time}`;
}
