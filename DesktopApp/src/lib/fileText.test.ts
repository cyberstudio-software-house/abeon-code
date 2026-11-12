import { describe, it, expect } from 'vitest';
import { decodeFileText, encodeFileText, fileDir, fileName, fileTabId, isMarkdownPath } from './fileText';

describe('decodeFileText', () => {
  it('strips the BOM, normalises CRLF and reports the predominant ending', () => {
    expect(decodeFileText('\uFEFFa\r\nb\r\nc\n')).toEqual({ text: 'a\nb\nc\n', eol: 'crlf', hasBom: true });
  });

  it('prefers lf on a tie', () => {
    expect(decodeFileText('a\r\nb\n')).toEqual({ text: 'a\nb\n', eol: 'lf', hasBom: false });
  });

  it('reports lf when there is no newline', () => {
    expect(decodeFileText('abc')).toEqual({ text: 'abc', eol: 'lf', hasBom: false });
  });

  it('leaves a lone carriage return untouched and uncounted', () => {
    expect(decodeFileText('a\rb\r\nc')).toEqual({ text: 'a\rb\nc', eol: 'crlf', hasBom: false });
    expect(decodeFileText('a\rb\rc')).toEqual({ text: 'a\rb\rc', eol: 'lf', hasBom: false });
  });
});

describe('encodeFileText', () => {
  it.each([
    ['pure LF', 'a\nb\nc\n'],
    ['pure CRLF', 'a\r\nb\r\nc\r\n'],
    ['BOM with CRLF', '\uFEFFa\r\nb\r\n'],
    ['BOM with LF', '\uFEFFa\nb\n'],
    ['no trailing newline', 'a\nb'],
    ['CRLF without trailing newline', 'a\r\nb'],
    ['empty file', ''],
    ['BOM-only file', '\uFEFF'],
  ])('round-trips %s', (_label, raw) => {
    const { text, eol, hasBom } = decodeFileText(raw);
    expect(encodeFileText(text, eol, hasBom)).toBe(raw);
  });

  it('turns every newline into the chosen ending and re-adds the BOM', () => {
    expect(encodeFileText('a\nb', 'crlf', true)).toBe('\uFEFFa\r\nb');
    expect(encodeFileText('a\nb', 'lf', false)).toBe('a\nb');
  });
});

describe('path helpers', () => {
  it('builds the tab id', () => {
    expect(fileTabId(3, 'src/a.ts')).toBe('file:3:src/a.ts');
  });

  it('splits a path into name and directory', () => {
    expect(fileName('a/b/c.ts')).toBe('c.ts');
    expect(fileName('c.ts')).toBe('c.ts');
    expect(fileDir('a/b/c.ts')).toBe('a/b');
    expect(fileDir('c.ts')).toBe('');
  });

  it('recognises markdown paths by the last extension only', () => {
    expect(isMarkdownPath('docs/A.MD')).toBe(true);
    expect(isMarkdownPath('a.md.txt')).toBe(false);
    expect(isMarkdownPath('x.markdown')).toBe(true);
    expect(isMarkdownPath('X.MDX')).toBe(true);
    expect(isMarkdownPath('a.mdx.txt')).toBe(false);
  });
});
