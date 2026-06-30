import { useEffect, useRef, useState } from 'react';
import { Terminal, type ILinkProvider, type ILink, type IBufferRange, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import '@xterm/xterm/css/xterm.css';
import { tauri, type PtyKindClient } from '../../lib/tauri';
import { useStore } from '../../store';
import { processManager } from '../../lib/processManager';
import { getCliModelString } from '../../lib/models';
import type { Provider } from '../../types';

type Props = {
  projectId: number;
  kind: 'agent' | 'action' | 'shell';
  provider?: Provider;
  sessionId?: string;
  fresh?: boolean;
  actionId?: number;
  tabId?: string;
  visible?: boolean;
};

const FILE_PATH_RE = /((?:\.\.?\/|~\/|\/|[\w@.-]+\/)[\w@.\/-]*\.\w{1,10})(?::(\d+)(?::(\d+))?|\((\d+)[,:](\d+)\))?/g;

function isModClick(e: MouseEvent) {
  return e.ctrlKey || e.metaKey;
}

function buildXtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    background:  v('--color-bg-elev') || (isDark ? '#1a1917' : '#ffffff'),
    foreground:  v('--color-fg') || (isDark ? '#e8e6e1' : '#1a1a1a'),
    cursor:      v('--color-accent') || '#b78640',
    cursorAccent: v('--color-bg-elev') || '#ffffff',
    selectionBackground: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
    black:   isDark ? '#1a1917' : '#1a1a1a',
    red:     '#c14a3d',
    green:   '#61c454',
    yellow:  '#f4be4f',
    blue:    '#5b9bd5',
    magenta: '#b78640',
    cyan:    '#4db8a4',
    white:   isDark ? '#e8e6e1' : '#52504a',
    brightBlack:   isDark ? '#6b6860' : '#94918a',
    brightRed:     '#ec6a5e',
    brightGreen:   '#7dd56f',
    brightYellow:  '#f5cf6e',
    brightBlue:    '#7db8e8',
    brightMagenta: '#d4a04e',
    brightCyan:    '#6dd4bf',
    brightWhite:   isDark ? '#faf8f5' : '#1a1a1a',
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

export function TerminalView({ projectId, kind, provider, sessionId, fresh, actionId, visible = true }: Props) {
  const defaultModelId = useStore(s => s.defaultModelId);
  const customModels = useStore(s => s.customModels);
  const codexModelId = useStore(s => s.codexModelId);
  const skipPermissions = useStore(s => s.skipPermissions);
  const setActiveAgentPtyId = useStore(s => s.setActiveAgentPtyId);
  const [agentPtyId, setAgentPtyId] = useState<string | null>(null);
  const projectPath = useStore(s => s.projects.find(p => p.id === projectId)?.path ?? '');
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

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      theme: buildXtermTheme(),
      cursorBlink: true,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (isModClick(event)) openUrl(uri);
    }));
    term.open(container);
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key === 'C') {
        const selection = term.getSelection();
        if (selection) {
          tauri.writeClipboardText(selection).catch(err =>
            console.warn('[copy] write_clipboard_text failed:', err)
          );
        }
        return false;
      }
      return true;
    });
    term.registerLinkProvider(createFilePathProvider(term, projectPathRef));
    fit.fit();
    if (visibleRef.current) term.focus();
    termRef.current = term;
    fitRef.current = fit;

    const cols = term.cols;
    const rows = term.rows;
    const agentProvider = provider ?? 'claude';
    const isResume = kind === 'agent' && !!sessionId && !fresh;
    const cliModel = !isResume && kind === 'agent' && agentProvider === 'claude'
      ? getCliModelString(defaultModelId, customModels)
      : undefined;
    const ptyKind: PtyKindClient =
      kind === 'agent'
        ? {
            kind: 'agent',
            provider: agentProvider,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(agentProvider === 'claude' && cliModel ? { model: cliModel } : {}),
            ...(agentProvider === 'codex' && !isResume && codexModelId ? { model: codexModelId } : {}),
            ...(fresh ? { fresh: true } : {}),
            ...(skipPermissions ? { skip_permissions: true } : {}),
          }
        : kind === 'action'
          ? { kind: 'action', action_id: actionId! }
          : { kind: 'shell' };

    let cancelled = false;
    if (kind !== 'action') {
    tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => {
      if (cancelled) {
        tauri.ptyKill(id).catch(() => {});
        return;
      }
      ptyRef.current = id;
      if (kind === 'agent') setAgentPtyId(id);
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
  }, [projectId, kind, provider, sessionId, fresh, actionId]);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      if (termRef.current) termRef.current.options.theme = buildXtermTheme();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

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
    term.focus();
  }, [visible]);

  useEffect(() => {
    if (kind !== 'agent' || !agentPtyId || !visible) return;
    setActiveAgentPtyId(agentPtyId);
    return () => setActiveAgentPtyId(null);
  }, [kind, agentPtyId, visible, setActiveAgentPtyId]);

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

  return <div ref={containerRef} className="h-full w-full bg-bg-elev p-4 pb-6" />;
}
