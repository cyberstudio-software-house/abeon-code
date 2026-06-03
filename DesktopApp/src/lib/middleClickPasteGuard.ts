// WebKitGTK (the Linux Tauri webview) pastes the X11 PRIMARY selection into the
// focused editable element on a middle-click. xterm keeps a focused helper
// textarea, so middle-clicking a tab to close it pastes the last selection into
// the active terminal. We arm a short window only when the middle-click lands
// OUTSIDE terminal content (`.xterm`) and swallow the resulting paste; a
// middle-click inside the terminal keeps native PRIMARY paste behaviour.

const GUARD_WINDOW_MS = 250;

let blockPasteUntil = 0;

function insideTerminal(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.('.xterm');
}

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 1) return;
  if (insideTerminal(e.target)) return;
  blockPasteUntil = Date.now() + GUARD_WINDOW_MS;
}

function armed(): boolean {
  return Date.now() < blockPasteUntil;
}

function swallow(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
  blockPasteUntil = 0;
}

function onPaste(e: ClipboardEvent): void {
  if (armed() && insideTerminal(e.target)) swallow(e);
}

function onBeforeInput(e: InputEvent): void {
  if (e.inputType === 'insertFromPaste' && armed() && insideTerminal(e.target)) swallow(e);
}

export function installMiddleClickPasteGuard(): () => void {
  document.addEventListener('mousedown', onMouseDown, { capture: true });
  document.addEventListener('paste', onPaste, { capture: true });
  document.addEventListener('beforeinput', onBeforeInput as EventListener, { capture: true });
  return () => {
    document.removeEventListener('mousedown', onMouseDown, { capture: true });
    document.removeEventListener('paste', onPaste, { capture: true });
    document.removeEventListener('beforeinput', onBeforeInput as EventListener, { capture: true });
  };
}
