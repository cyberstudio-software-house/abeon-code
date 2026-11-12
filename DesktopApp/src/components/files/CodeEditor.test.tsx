import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { CodeEditor, diffRange } from './CodeEditor';

const mount = (value: string, onChange = vi.fn(), onSave = vi.fn()) => {
  const view = render(<CodeEditor value={value} path="notes.txt" onChange={onChange} onSave={onSave} focused={false} />);
  const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement)!;
  const update = (next: string) => view.rerender(<CodeEditor value={next} path="notes.txt" onChange={onChange} onSave={onSave} focused={false} />);
  return { editor, update, onChange, onSave };
};

const paste = (editor: EditorView, text: string) => {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
  editor.contentDOM.dispatchEvent(event);
};

describe('CodeEditor', () => {
  it('applies an external value without reporting it back', () => {
    const { editor, update, onChange } = mount('hello\n');
    update('theirs\nsecond\n');
    expect(editor.state.doc.toString()).toBe('theirs\nsecond\n');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reads the document once per keystroke, also when the store hands the typed text back', () => {
    const { editor, update, onChange } = mount('hello\n');
    const reads = vi.spyOn(Text.prototype, 'toString');
    editor.dispatch({ changes: { from: 0, insert: 'X' } });
    update(onChange.mock.calls[0][0]);
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    expect(editor.state.doc.toString()).toBe('Xhello\n');
  });

  it('applies an external value that equals text typed earlier but not the current document', () => {
    const { editor, update, onChange } = mount('a');
    editor.dispatch({ changes: { from: 1, insert: 'b' } });
    update('ab');
    update('theirs');
    expect(editor.state.doc.toString()).toBe('theirs');
    editor.dispatch({ changes: { from: 6, insert: '!' } });
    update('theirs!');
    update('ab');
    expect(editor.state.doc.toString()).toBe('ab');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('takes the monospace font from the app font-mono class', () => {
    const view = render(<CodeEditor value="a" path="notes.txt" onChange={vi.fn()} onSave={vi.fn()} focused={false} />);
    expect(view.container.firstElementChild).toHaveClass('font-mono');
  });

  it('takes the keyboard back when the focus token changes while focused', () => {
    const props = { value: 'a', path: 'notes.txt', onChange: vi.fn(), onSave: vi.fn(), focused: true };
    const view = render(<CodeEditor {...props} focusToken={0} />);
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor') as HTMLElement)!;
    expect(editor.hasFocus).toBe(true);
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(editor.hasFocus).toBe(false);

    view.rerender(<CodeEditor {...props} focusToken={0} />);
    expect(editor.hasFocus).toBe(false);
    view.rerender(<CodeEditor {...props} focusToken={1} />);
    expect(editor.hasFocus).toBe(true);
    elsewhere.remove();
  });

  it('reports a user change with the full text', () => {
    const { editor, onChange } = mount('hello\n');
    editor.dispatch({ changes: { from: 0, insert: 'X' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('Xhello\n');
  });

  it('keeps the same view across external updates', () => {
    const { editor, update } = mount('a');
    update('b');
    update('c');
    expect(editor.state.doc.toString()).toBe('c');
    expect(editor.dom.isConnected).toBe(true);
  });

  it('has nothing to undo after an external change', () => {
    const { editor, update, onChange } = mount('hello world\n');
    editor.dispatch({ changes: { from: 6, to: 11, insert: '' } });
    onChange.mockClear();
    update('theirs from disk\nsecond line\n');
    expect(undo(editor)).toBe(false);
    expect(editor.state.doc.toString()).toBe('theirs from disk\nsecond line\n');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can undo user edits made after an external change', () => {
    const { editor, update } = mount('a\n');
    update('b\n');
    editor.dispatch({ changes: { from: 0, insert: 'X' } });
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe('b\n');
  });

  it('keeps a lone carriage return and CRLF inside the document text', () => {
    const { editor, update } = mount('a\rb\nc');
    expect(editor.state.doc.lines).toBe(2);
    expect(editor.state.doc.toString()).toBe('a\rb\nc');
    update('new\r\nx');
    expect(editor.state.doc.toString()).toBe('new\r\nx');
  });

  it('turns pasted CRLF line breaks into LF and keeps a lone carriage return', () => {
    const { editor, onChange } = mount('');
    paste(editor, 'X=3\r\nY=4\r\n');
    expect(editor.state.doc.toString()).toBe('X=3\nY=4\n');
    expect(onChange).toHaveBeenLastCalledWith('X=3\nY=4\n');
    paste(editor, 'a\rb');
    expect(editor.state.doc.toString()).toBe('X=3\nY=4\na\rb');
  });

  it('runs dropped text through the same clipboard input filter', () => {
    const { editor } = mount('');
    const filters = editor.state.facet(EditorView.clipboardInputFilter);
    expect(filters.reduce((text, filter) => filter(text, editor.state), 'one\r\ntwo\rthree')).toBe('one\ntwo\rthree');
  });

  it('calls onSave on Ctrl+S and prevents the browser default', () => {
    const { editor, onSave } = mount('a');
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    editor.contentDOM.dispatchEvent(event);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not swallow keys it does not handle', () => {
    const { editor } = mount('a');
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    const event = new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true });
    editor.contentDOM.dispatchEvent(event);
    document.removeEventListener('keydown', seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('diffRange', () => {
  it('returns null for identical texts', () => {
    expect(diffRange('same\n', 'same\n')).toBeNull();
  });

  it('finds an appended tail', () => {
    expect(diffRange('abc', 'abcdef')).toEqual({ from: 3, to: 3, insert: 'def' });
  });

  it('finds a removed tail', () => {
    expect(diffRange('abcdef', 'abc')).toEqual({ from: 3, to: 6, insert: '' });
  });

  it('finds a prepended head', () => {
    expect(diffRange('def', 'abcdef')).toEqual({ from: 0, to: 0, insert: 'abc' });
  });

  it('finds the differing middle', () => {
    expect(diffRange('one\ntwo\nthree\n', 'one\n2\nthree\n')).toEqual({ from: 4, to: 7, insert: '2' });
  });

  it('never overlaps prefix and suffix on repeated characters', () => {
    expect(diffRange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' });
    expect(diffRange('aaaa', 'aa')).toEqual({ from: 2, to: 4, insert: '' });
  });

  it('replaces a whole different text', () => {
    expect(diffRange('abc', 'xyz')).toEqual({ from: 0, to: 3, insert: 'xyz' });
  });

  it('does not split a surrogate pair', () => {
    const change = diffRange('a\u{1F600}b', 'a\u{1F601}b')!;
    expect(change).toEqual({ from: 1, to: 3, insert: '\u{1F601}' });
  });

  it('reconstructs the new text when applied', () => {
    const pairs: [string, string][] = [['', 'x'], ['x', ''], ['hello world\n', 'theirs\n'], ['a\rb', 'a\r\nb']];
    for (const [oldText, newText] of pairs) {
      const change = diffRange(oldText, newText)!;
      expect(oldText.slice(0, change.from) + change.insert + oldText.slice(change.to)).toBe(newText);
    }
  });
});
