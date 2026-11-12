export type Eol = 'lf' | 'crlf';

const BOM = '﻿';

export const fileTabId = (projectId: number, path: string) => `file:${projectId}:${path}`;

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function fileDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function decodeFileText(raw: string): { text: string; eol: Eol; hasBom: boolean } {
  const hasBom = raw.startsWith(BOM);
  const body = hasBom ? raw.slice(1) : raw;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length - crlf;
  return { text: body.replace(/\r\n/g, '\n'), eol: crlf > lf ? 'crlf' : 'lf', hasBom };
}

export function encodeFileText(text: string, eol: Eol, hasBom: boolean): string {
  const body = eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  return hasBom ? BOM + body : body;
}
