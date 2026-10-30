import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, type ILinkProvider, type ILink, type IBufferRange } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import '@xterm/xterm/css/xterm.css';
import { tauri, type PtyKindClient } from '../../lib/tauri';
import { useStore } from '../../store';
import { processManager } from '../../lib/processManager';
import { supervisorProcess } from '../../lib/supervisorProcess';
import { getCliModelString } from '../../lib/models';
import type { Provider } from '../../types';
import { formatTauriError } from '../../lib/errors';
import { toast } from 'sonner';
import { terminalOptions } from '../../lib/terminalAppearance';
import { useTerminalAppearance } from './useTerminalAppearance';

type Props = {
  projectId?: number;
  kind: 'agent' | 'action' | 'shell' | 'supervisor';
  ptyId?: string;
  provider?: Provider;
  sessionId?: string;
  fresh?: boolean;
  actionId?: number;
  tabId?: string;
  visible?: boolean;
  focused?: boolean;
  takeFocus?: boolean;
  focusToken?: number;
  onExit?: (code: number) => void;
};

const FILE_PATH_RE = /((?:\.\.?\/|~\/|\/|[\w@.-]+\/)[\w@.\/-]*\.\w{1,10})(?::(\d+)(?::(\d+))?|\((\d+)[,:](\d+)\))?/g;

function isModClick(e: MouseEvent) {
  return e.ctrlKey || e.metaKey;
}

type AppEnv = { appTheme: 'dark' | 'light'; accent: string };

function readAppEnv(): AppEnv {
  const root = document.documentElement;
  return {
    appTheme: root.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    accent: getComputedStyle(root).getPropertyValue('--color-accent').trim() || '#F0B44C',
  };
}

function createFilePathProvider(term: Terminal, projectPathRef: { current: string }): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString();
      const links: ILink[] = [];
      let m: RegExpExecArray | null;
      FILE_PATH_RE.lastIndex = 0;
      while ((m = FILE_PATH_RE.exec(text)) !== null) {
        const before = text.substring(Math.max(0, m.index - 10), m.index);
        if (/:\/\//.test(before)) continue;

        const filePath = m[1];
        const lineNum = m[2] ? parseInt(m[2]) : m[4] ? parseInt(m[4]) : undefined;
        const colNum = m[3] ? parseInt(m[3]) : m[5] ? parseInt(m[5]) : undefined;
        const startX = m.index + 1;
        const endX = m.index + m[0].length;
        const range: IBufferRange = {
          start: { x: startX, y: bufferLineNumber },
          end: { x: endX, y: bufferLineNumber },
        };

        links.push({
          range,
          text: m[0],
          activate(event) {
            if (!isModClick(event)) return;
            tauri.openInEditor(projectPathRef.current, filePath, lineNum, colNum).catch(err =>
              console.warn('[link] open_in_editor failed:', err)
            );
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}

export function TerminalView({ projectId, kind, ptyId, provider, sessionId, fresh, actionId, tabId, visible = true, focused = true, takeFocus, focusToken, onExit }: Props) {
  const defaultModelId = useStore(s => s.defaultModelId);
  const modelEfforts = useStore(s => s.modelEfforts);
  const codexModelId = useStore(s => s.codexModelId);
  const opencodeModelId = useStore(s => s.opencodeModelId);
  const skipPermissions = useStore(s => s.skipPermissions);
  const setActiveAgentPtyId = useStore(s => s.setActiveAgentPtyId);
  const markSessionPtyStarted = useStore(s => s.markSessionPtyStarted);
  const consumeInitialPrompt = useStore(s => s.consumeInitialPrompt);
  const [agentPtyId, setAgentPtyId] = useState<string | null>(null);
  const projectPath = useStore(s => projectId == null ? '' : s.projects.find(p => p.id === projectId)?.path ?? '');
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);
  const pendingWrites = useRef<Uint8Array[]>([]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const claimsKeyboard = takeFocus ?? focused;
  const claimsKeyboardRef = useRef(claimsKeyboard);
  claimsKeyboardRef.current = claimsKeyboard;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const appearance = useTerminalAppearance();
  const [appEnv, setAppEnv] = useState(readAppEnv);
  const options = useMemo(
    () => terminalOptions(appearance, appEnv.appTheme, appEnv.accent),
    [appearance, appEnv],
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const term = new Terminal({
      ...optionsRef.current,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (isModClick(event)) openUrl(uri);
    }));
    term.open(container);
    const copySelection = () => {
      const selection = term.getSelection();
      if (selection) {
        tauri.writeClipboardText(selection).catch(err =>
          console.warn('[copy] write_clipboard_text failed:', err)
        );
      }
    };
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'C') {
        copySelection();
        return false;
      }
      return true;
    });
    let copyOnSelectTimer: ReturnType<typeof setTimeout> | undefined;
    const offSelectionChange = term.onSelectionChange(() => {
      if (copyOnSelectTimer !== undefined) clearTimeout(copyOnSelectTimer);
      copyOnSelectTimer = setTimeout(copySelection, 120);
    });
    unlistenRefs.current.push(() => {
      if (copyOnSelectTimer !== undefined) clearTimeout(copyOnSelectTimer);
      offSelectionChange.dispose();
    });
    term.registerLinkProvider(createFilePathProvider(term, projectPathRef));
    fit.fit();
    if (visibleRef.current && claimsKeyboardRef.current) term.focus();
    termRef.current = term;
    fitRef.current = fit;

    const cols = term.cols;
    const rows = term.rows;
    const agentProvider = provider ?? 'claude';
    const isResume = kind === 'agent' && !!sessionId && !fresh;
    const isNewClaudeAgent = !isResume && kind === 'agent' && agentProvider === 'claude';
    const cliModel = isNewClaudeAgent ? getCliModelString(defaultModelId) : undefined;
    const cliEffort = isNewClaudeAgent ? modelEfforts[defaultModelId] : undefined;
    const seededTab = isNewClaudeAgent && tabId ? useStore.getState().tabs.find(t => t.id === tabId) : undefined;
    const initialPrompt = seededTab?.kind === 'session' ? seededTab.initialPrompt : undefined;
    const ptyKind: PtyKindClient =
      kind === 'agent'
        ? {
            kind: 'agent',
            provider: agentProvider,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(agentProvider === 'claude' && cliModel ? { model: cliModel } : {}),
            ...(agentProvider === 'claude' && cliEffort ? { effort: cliEffort } : {}),
            ...(agentProvider === 'codex' && !isResume && codexModelId ? { model: codexModelId } : {}),
            ...(agentProvider === 'opencode' && !isResume && opencodeModelId ? { model: opencodeModelId } : {}),
            ...(fresh ? { fresh: true } : {}),
            ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
            ...(skipPermissions ? { skip_permissions: true } : {}),
          }
        : kind === 'action'
          ? { kind: 'action', action_id: actionId! }
          : { kind: 'shell' };

    let cancelled = false;
    if (projectId != null && (kind === 'agent' || kind === 'shell')) {
    tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => {
      if (cancelled) {
        tauri.ptyKill(id).catch(() => {});
        return;
      }
      ptyRef.current = id;
      if (initialPrompt && tabId) consumeInitialPrompt(tabId);
      if (kind === 'agent') setAgentPtyId(id);
      if (kind === 'agent' && tabId) markSessionPtyStarted(tabId, id);
      const offOut = await tauri.onPtyOutput(id, (bytes) => {
        if (cancelled) return;
        if (visibleRef.current) {
          term.write(bytes);
        } else {
          pendingWrites.current.push(bytes);
        }
      });
      const offExit = await tauri.onPtyExit(id, (code) => {
        if (cancelled) return;
        term.write(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`);
        onExitRef.current?.(code);
      });
      unlistenRefs.current.push(offOut, offExit);

      term.onData((d) => {
        if (cancelled) return;
        const enc = btoa(unescape(encodeURIComponent(d)));
        tauri.ptyWrite(id, enc).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        if (cancelled) return;
        tauri.ptyResize(id, cols, rows).catch(() => {});
      });

      if (kind === 'agent') {
        const onKeyDown = async (e: KeyboardEvent) => {
          if (!((e.ctrlKey || e.metaKey) && e.key === 'v')) return;
          e.preventDefault();
          e.stopPropagation();

          try {
            const imagePath = await tauri.readClipboardImage(id);
            console.log('[paste] arboard image:', imagePath);
            if (imagePath) {
              const enc = btoa(unescape(encodeURIComponent(imagePath)));
              await tauri.ptyWrite(id, enc);
              return;
            }
          } catch (err) {
            console.log('[paste] arboard image error:', err);
          }

          try {
            const text = await tauri.readClipboardText();
            console.log('[paste] arboard text:', text ? `"${text.slice(0, 60)}"` : 'null');
            if (text) {
              const enc = btoa(unescape(encodeURIComponent(text)));
              await tauri.ptyWrite(id, enc);
            }
          } catch (err) {
            console.log('[paste] arboard text error:', err);
          }
        };

        container.addEventListener('keydown', onKeyDown, { capture: true });
        unlistenRefs.current.push(() =>
          container.removeEventListener('keydown', onKeyDown, { capture: true })
        );
      }
    }).catch(error => {
      if (!cancelled) {
        term.write(`\r\n\x1b[31m${formatTauriError(error)}\x1b[0m\r\n`);
        if (initialPrompt) toast.error(`Nie udało się uruchomić sesji z promptem w ${projectPathRef.current}: ${formatTauriError(error)}`);
      }
    });
    }

    return () => {
      cancelled = true;
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
      if (ptyRef.current) tauri.ptyKill(ptyRef.current).catch(() => {});
      ptyRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      // Do NOT call term.dispose() — it triggers webkit2gtk crash.
      // React removes the DOM container; PTY is killed; listeners detached.
      // xterm internal state will be GC'd with the Terminal object.
    };
  }, [projectId, kind, provider, sessionId, fresh, actionId, tabId, markSessionPtyStarted, consumeInitialPrompt]);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const next = readAppEnv();
      setAppEnv(prev => (prev.appTheme === next.appTheme && prev.accent === next.accent ? prev : next));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const fit = fitRef.current;
    const container = containerRef.current;
    const refit = () => {
      if (fit && visibleRef.current && container && container.offsetWidth > 0 && container.offsetHeight > 0) {
        fit.fit();
      }
    };
    term.options.fontFamily = options.fontFamily;
    term.options.fontSize = options.fontSize;
    term.options.lineHeight = options.lineHeight;
    term.options.cursorStyle = options.cursorStyle;
    term.options.cursorBlink = options.cursorBlink;
    term.options.theme = options.theme;
    refit();
    let stale = false;
    document.fonts?.load(`${options.fontSize}px ${options.fontFamily}`).then(() => {
      if (stale || termRef.current !== term) return;
      term.options.fontFamily = options.fontFamily;
      refit();
    }).catch(() => {});
    return () => { stale = true; };
  }, [options]);

  const actionPtyId = useStore(s =>
    kind === 'action' && actionId != null ? s.runningActions[actionId]?.ptyId : undefined
  );

  useEffect(() => {
    if (kind !== 'action' || actionId == null) return;
    const term = termRef.current;
    if (!term || !actionPtyId) return;

    term.reset();
    pendingWrites.current = [];
    const sink = {
      write: (bytes: Uint8Array) => {
        if (visibleRef.current) term.write(bytes);
        else pendingWrites.current.push(bytes);
      },
    };
    const detach = processManager.attach(actionId, sink);
    const offData = term.onData((d) => {
      const enc = btoa(unescape(encodeURIComponent(d)));
      processManager.write(actionId, enc);
    });
    const offResize = term.onResize(({ cols, rows }) => processManager.resize(actionId, cols, rows));
    processManager.resize(actionId, term.cols, term.rows);

    return () => { detach(); offData.dispose(); offResize.dispose(); };
  }, [kind, actionId, actionPtyId]);

  useEffect(() => {
    if (kind !== 'supervisor' || !ptyId) return;
    const term = termRef.current;
    if (!term) return;

    term.reset();
    pendingWrites.current = [];
    const sink = {
      write: (bytes: Uint8Array) => {
        if (visibleRef.current) term.write(bytes);
        else pendingWrites.current.push(bytes);
      },
    };
    const detach = supervisorProcess.attach(ptyId, sink);
    const offData = term.onData((d) => {
      const enc = btoa(unescape(encodeURIComponent(d)));
      supervisorProcess.write(ptyId, enc);
    });
    const offResize = term.onResize(({ cols, rows }) => supervisorProcess.resize(ptyId, cols, rows));
    supervisorProcess.resize(ptyId, term.cols, term.rows);

    return () => { detach(); offData.dispose(); offResize.dispose(); };
  }, [kind, ptyId]);

  useEffect(() => {
    if (!visible || !termRef.current || !fitRef.current) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const container = containerRef.current;
    if (!container || container.offsetWidth === 0) return;

    // Flush pending writes that arrived while hidden
    for (const bytes of pendingWrites.current) {
      term.write(bytes);
    }
    pendingWrites.current = [];
    fit.fit();
    if (claimsKeyboard) term.focus();
  }, [visible, claimsKeyboard, focusToken]);

  useEffect(() => {
    if (kind !== 'agent' || !agentPtyId || !visible || !focused) return;
    setActiveAgentPtyId(agentPtyId);
    return () => setActiveAgentPtyId(null);
  }, [kind, agentPtyId, visible, focused, setActiveAgentPtyId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const fit = fitRef.current;
    if (!fit) return;

    const safeFit = () => {
      if (visibleRef.current && container.offsetWidth > 0 && container.offsetHeight > 0) {
        fit.fit();
      }
    };

    window.addEventListener('resize', safeFit);
    const ro = new ResizeObserver(safeFit);
    ro.observe(container);
    return () => {
      window.removeEventListener('resize', safeFit);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="h-full w-full p-4 pb-6" style={{ backgroundColor: options.theme.background }}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
