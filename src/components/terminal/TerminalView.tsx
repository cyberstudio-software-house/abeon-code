import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { tauri, type PtyKindClient } from '../../lib/tauri';
import { useStore } from '../../store';
import { getCliModelString } from '../../lib/models';

type Props = {
  projectId: number;
  kind: 'claude' | 'action' | 'shell';
  sessionId?: string;
  actionId?: number;
  visible?: boolean;
};

export function TerminalView({ projectId, kind, sessionId, actionId, visible = true }: Props) {
  const defaultModelId = useStore(s => s.defaultModelId);
  const customModels = useStore(s => s.customModels);
  const skipPermissions = useStore(s => s.skipPermissions);
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
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
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
      },
      cursorBlink: true,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const cols = term.cols;
    const rows = term.rows;
    const isResume = kind === 'claude' && !!sessionId;
    const cliModel = !isResume && kind === 'claude'
      ? getCliModelString(defaultModelId, customModels)
      : undefined;
    const ptyKind: PtyKindClient =
      kind === 'claude'
        ? { kind: 'claude', ...(sessionId ? { session_id: sessionId } : {}), ...(cliModel ? { model: cliModel } : {}), ...(skipPermissions ? { skip_permissions: true } : {}) }
        : kind === 'action'
          ? { kind: 'action', action_id: actionId! }
          : { kind: 'shell' };

    let cancelled = false;
    tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => {
      if (cancelled) {
        tauri.ptyKill(id).catch(() => {});
        return;
      }
      ptyRef.current = id;
      const offOut = await tauri.onPtyOutput(id, (bytes) => {
        if (cancelled) return;
        if (visibleRef.current) {
          term.write(bytes);
        } else {
          pendingWrites.current.push(bytes);
        }
      });
      const offExit = await tauri.onPtyExit(id, (code) => {
        if (!cancelled) term.write(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`);
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

      if (kind === 'claude') {
        const onPaste = async (evt: Event) => {
          const e = evt as ClipboardEvent;
          e.preventDefault();
          e.stopPropagation();

          try {
            const imagePath = await tauri.readClipboardImage(id);
            if (imagePath) {
              const encoded = btoa(unescape(encodeURIComponent(imagePath)));
              await tauri.ptyWrite(id, encoded);
              return;
            }
          } catch {
            // native clipboard read failed — fall through to text
          }

          const text = e.clipboardData?.getData('text/plain');
          if (text) {
            const encoded = btoa(unescape(encodeURIComponent(text)));
            await tauri.ptyWrite(id, encoded);
          }
        };

        container.addEventListener('paste', onPaste, { capture: true });
        unlistenRefs.current.push(() =>
          container.removeEventListener('paste', onPaste, { capture: true })
        );
      }
    });

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
  }, [projectId, kind, sessionId, actionId]);

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
  }, [visible]);

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
