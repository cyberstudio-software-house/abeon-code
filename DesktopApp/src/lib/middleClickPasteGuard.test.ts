import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installMiddleClickPasteGuard } from './middleClickPasteGuard';

const MIDDLE = 1;
const LEFT = 0;

function dispatchMouseDown(target: Element, button: number) {
  target.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true, cancelable: true }));
}

function dispatchPaste(target: Element): Event {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe('middleClickPasteGuard', () => {
  let uninstall: () => void;
  let tab: HTMLElement;
  let termTextarea: HTMLTextAreaElement;

  beforeEach(() => {
    uninstall = installMiddleClickPasteGuard();

    tab = document.createElement('div');
    tab.dataset.tabId = 'tab-1';
    document.body.appendChild(tab);

    const term = document.createElement('div');
    term.classList.add('xterm');
    termTextarea = document.createElement('textarea');
    termTextarea.classList.add('xterm-helper-textarea');
    term.appendChild(termTextarea);
    document.body.appendChild(term);
  });

  afterEach(() => {
    uninstall();
    document.body.replaceChildren();
  });

  it('blocks the paste that follows a middle-click outside the terminal', () => {
    dispatchMouseDown(tab, MIDDLE);
    const paste = dispatchPaste(termTextarea);
    expect(paste.defaultPrevented).toBe(true);
  });

  it('allows a middle-click paste that originates inside the terminal', () => {
    dispatchMouseDown(termTextarea, MIDDLE);
    const paste = dispatchPaste(termTextarea);
    expect(paste.defaultPrevented).toBe(false);
  });

  it('allows a keyboard paste (no preceding middle-click)', () => {
    const paste = dispatchPaste(termTextarea);
    expect(paste.defaultPrevented).toBe(false);
  });

  it('does not arm on a left middle-click', () => {
    dispatchMouseDown(tab, LEFT);
    const paste = dispatchPaste(termTextarea);
    expect(paste.defaultPrevented).toBe(false);
  });

  it('consumes the guard so a later unrelated paste is unaffected', () => {
    dispatchMouseDown(tab, MIDDLE);
    expect(dispatchPaste(termTextarea).defaultPrevented).toBe(true);
    expect(dispatchPaste(termTextarea).defaultPrevented).toBe(false);
  });
});
