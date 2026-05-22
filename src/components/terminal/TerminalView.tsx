import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { tauri, type PtyKindClient } from '../../lib/tauri';

type Props = {
  projectId: number;
  kind: 'claude' | 'action';
  sessionId?: string;
  actionId?: number;
};

export function TerminalView({ projectId, kind, sessionId, actionId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const bg =
      getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0f1115';
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: bg },
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
    const ptyKind: PtyKindClient =
      kind === 'claude'
        ? { kind: 'claude', session_id: sessionId! }
        : { kind: 'action', action_id: actionId! };

    let cancelled = false;
    tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => {
      if (cancelled) {
        tauri.ptyKill(id).catch(() => {});
        return;
      }
      ptyRef.current = id;
      const offOut = await tauri.onPtyOutput(id, (bytes) => term.write(bytes));
      const offExit = await tauri.onPtyExit(id, (code) =>
        term.write(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`),
      );
      unlistenRefs.current.push(offOut, offExit);

      term.onData((d) => {
        const enc = btoa(unescape(encodeURIComponent(d)));
        tauri.ptyWrite(id, enc).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        tauri.ptyResize(id, cols, rows).catch(() => {});
      });
    });

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
      if (ptyRef.current) tauri.ptyKill(ptyRef.current).catch(() => {});
      ptyRef.current = null;
      term.dispose();
    };
  }, [projectId, kind, sessionId, actionId]);

  return <div ref={containerRef} className="h-full w-full bg-bg p-2" />;
}
