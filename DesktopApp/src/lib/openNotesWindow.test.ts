import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setFocus, getByLabel, once, webviewWindow, toastError } = vi.hoisted(() => {
  const once = vi.fn();
  const webviewWindow = vi.fn(function (this: { once: typeof once }, _label: string) {
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
    await errorCall?.[1]({ payload: 'boom' });
    expect(toastError).toHaveBeenCalledWith('Nie udało się otworzyć okna notatek');
  });

  it('focuses the winning window when concurrent requests race to create the same label', async () => {
    let resolveLookup!: (value: null) => void;
    const lookup = new Promise<null>((resolve) => { resolveLookup = resolve; });
    getByLabel.mockReturnValueOnce(lookup).mockReturnValueOnce(lookup);

    const first = openNotesWindow(7, 'Demo');
    const second = openNotesWindow(7, 'Demo');
    expect(getByLabel).toHaveBeenCalledTimes(2);

    resolveLookup(null);
    await Promise.all([first, second]);
    expect(WebviewWindow).toHaveBeenCalledTimes(2);
    expect(webviewWindow.mock.calls.map(([label]) => label)).toEqual([
      'notes-project-7', 'notes-project-7',
    ]);

    getByLabel.mockResolvedValue({ setFocus });
    const errorCalls = once.mock.calls.filter(([event]) => event === 'tauri://error');
    await errorCalls[1][1]({ payload: 'window label already exists' });

    expect(getByLabel).toHaveBeenLastCalledWith('notes-project-7');
    expect(setFocus).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('recovers when another webview creates the window after the initial lookup', async () => {
    await openNotesWindow(9, 'Other project');
    getByLabel.mockResolvedValue({ setFocus });

    const errorCall = once.mock.calls.find(([event]) => event === 'tauri://error');
    await errorCall?.[1]({ payload: 'window label already exists' });

    expect(getByLabel).toHaveBeenLastCalledWith('notes-project-9');
    expect(setFocus).toHaveBeenCalledOnce();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('reports creation failure when the recovery lookup fails', async () => {
    await openNotesWindow(7, 'Demo');
    getByLabel.mockRejectedValue(new Error('lookup failed'));

    const errorCall = once.mock.calls.find(([event]) => event === 'tauri://error');
    await errorCall?.[1]({ payload: 'boom' });

    expect(getByLabel).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith('Nie udało się otworzyć okna notatek');
    expect(setFocus).not.toHaveBeenCalled();
  });

  it('reports creation failure when the recovered window cannot receive focus', async () => {
    await openNotesWindow(7, 'Demo');
    getByLabel.mockResolvedValue({ setFocus });
    setFocus.mockRejectedValueOnce(new Error('window closed'));

    const errorCall = once.mock.calls.find(([event]) => event === 'tauri://error');
    await errorCall?.[1]({ payload: 'window label already exists' });

    expect(setFocus).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError).toHaveBeenCalledWith('Nie udało się otworzyć okna notatek');
  });
});
