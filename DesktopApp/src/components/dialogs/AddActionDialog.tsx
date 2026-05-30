import { useEffect, useMemo, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { DetectedScript } from '../../types';

type Props = { projectId: number; projectPath: string; onClose: () => void; onAdded: () => void };

export function AddActionDialog({ projectId, projectPath, onClose, onAdded }: Props) {
  const [scripts, setScripts] = useState<DetectedScript[]>([]);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [preCommand, setPreCommand] = useState('');

  useEffect(() => {
    tauri.detectScripts(projectPath).then(setScripts).catch(() => {});
  }, [projectPath]);

  const grouped = useMemo(() => {
    const root = scripts.filter(s => !s.subdir);
    const subdirs = new Map<string, DetectedScript[]>();
    for (const s of scripts) {
      if (!s.subdir) continue;
      const arr = subdirs.get(s.subdir) ?? [];
      arr.push(s);
      subdirs.set(s.subdir, arr);
    }
    const sorted = [...subdirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { root, subdirs: sorted };
  }, [scripts]);

  const useDetected = (s: DetectedScript) => {
    setLabel(s.label);
    setCommand(s.command);
    setWorkingDir(s.subdir ?? '');
  };

  const submit = async () => {
    await tauri.addAction({
      projectId, label: label.trim(), command: command.trim(),
      workingDir: workingDir.trim() || null, source: 'manual',
      preCommand: preCommand.trim() || null,
    });
    onAdded();
    onClose();
  };

  const hasScripts = scripts.length > 0;

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[480px] max-h-[80vh] overflow-auto">
        <h2 className="text-[14px] font-semibold mb-3">Dodaj akcję</h2>
        {hasScripts && (
          <div className="mb-3">
            <div className="text-[11px] text-muted mb-1">Wykryte skrypty (kliknij aby uzupełnić pola):</div>
            <div className="space-y-0.5 max-h-52 overflow-auto border border-border p-2">
              {grouped.root.map((s, i) => (
                <ScriptButton key={`root-${i}`} script={s} onClick={useDetected} />
              ))}
              {grouped.subdirs.map(([dir, items]) => (
                <div key={dir}>
                  <div className="text-[9px] text-muted uppercase tracking-wider mt-2 mb-0.5 px-2 border-t border-border/50 pt-1.5">
                    {dir}/
                  </div>
                  {items.map((s, i) => (
                    <ScriptButton key={`${dir}-${i}`} script={s} onClick={useDetected} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Etykieta</label>
        <input value={label} onChange={e => setLabel(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-3" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Komenda</label>
        <input value={command} onChange={e => setCommand(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-3 font-mono" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Katalog roboczy</label>
        <input value={workingDir} onChange={e => setWorkingDir(e.target.value)}
          placeholder="(katalog projektu)"
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-3 font-mono text-muted placeholder:text-muted/50" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Komenda przygotowująca</label>
        <input value={preCommand} onChange={e => setPreCommand(e.target.value)}
          placeholder="np. nvm use 18"
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-1 font-mono placeholder:text-muted/50" />
        <p className="text-[10px] text-muted mb-4">
          Wykonywana przed komendą. Użyteczne dla <code className="font-mono">nvm use X</code> / <code className="font-mono">fnm use X</code>. Bez końcowego <code className="font-mono">&amp;&amp;</code>.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Anuluj</button>
          <button onClick={submit} disabled={!label.trim() || !command.trim()}
            className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium">Dodaj</button>
        </div>
      </div>
    </div>
  );
}

function ScriptButton({ script, onClick }: { script: DetectedScript; onClick: (s: DetectedScript) => void }) {
  return (
    <button onClick={() => onClick(script)}
      className="w-full text-left px-2 py-1 hover:bg-bg-elev-2 text-[11px]">
      <span className="text-[10px] text-muted uppercase mr-2">{script.source}</span>
      <span className="font-mono">{script.label}</span>
    </button>
  );
}
