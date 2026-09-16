import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setFocus, getByLabel, once, webviewWindow, toastError } = vi.hoisted(() => {
  const once = vi.fn();
  const webviewWindow = vi.fn(function (this: { once: typeof once }) {
    this.once = once;
  });
  return {
    setFocus: vi.fn(),
    getByLabel: vi.fn(),
    once,
    webviewWindow,
    toastError: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: Object.assign(webviewWindow, { getByLabel }),
}));

vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openNotesWindow } from './openNotesWindow';

describe('openNotesWindow', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getByLabel.mockResolvedValue(null);
    once.mockResolvedValue(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('focuses the existing project notes window', async () => {
    getByLabel.mockResolvedValue({ setFocus });

    await openNotesWindow(7, 'Demo');

    expect(getByLabel).toHaveBeenCalledWith('notes-project-7');
    expect(setFocus).toHaveBeenCalledOnce();
    expect(WebviewWindow).not.toHaveBeenCalled();
  });

  it('creates a correctly sized window when none exists', async () => {
    await openNotesWindow(7, 'Demo');

    expect(WebviewWindow).toHaveBeenCalledWith('notes-project-7', expect.objectContaining({
      url: 'index.html?view=notes&projectId=7',
      title: 'Notatki — Demo',
      width: 920,
      height: 680,
      minWidth: 720,
      minHeight: 520,
    }));
  });

  it('shows an error toast when window creation fails', async () => {
    await openNotesWindow(7, 'Demo');

    const errorCall = once.mock.calls.find(([event]) => event === 'tauri://error');
    expect(errorCall).toBeDefined();
    errorCall?.[1]({ payload: 'boom' });
    expect(toastError).toHaveBeenCalledWith('Nie udało się otworzyć okna notatek');
  });
});
