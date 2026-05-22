import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { DetectedScript } from '../../types';

type Props = { projectId: number; projectPath: string; onClose: () => void; onAdded: () => void };

export function AddActionDialog({ projectId, projectPath, onClose, onAdded }: Props) {
  const [scripts, setScripts] = useState<DetectedScript[]>([]);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  useEffect(() => {
    tauri.detectScripts(projectPath).then(setScripts).catch(() => {});
  }, [projectPath]);

  const useDetected = (s: DetectedScript) => {
    setLabel(s.label);
    setCommand(s.command);
  };

  const submit = async () => {
    await tauri.addAction({
      projectId, label: label.trim(), command: command.trim(),
      workingDir: null, source: 'manual',
    });
    onAdded();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[480px] max-h-[80vh] overflow-auto">
        <h2 className="text-[14px] font-semibold mb-3">Dodaj akcję</h2>
        {scripts.length > 0 && (
          <div className="mb-3">
            <div className="text-[11px] text-muted mb-1">Wykryte skrypty (kliknij aby uzupełnić pola):</div>
            <div className="space-y-0.5 max-h-40 overflow-auto border border-border p-2">
              {scripts.map((s, i) => (
                <button key={i} onClick={() => useDetected(s)}
                  className="w-full text-left px-2 py-1 hover:bg-bg-elev-2 text-[11px]">
                  <span className="text-[10px] text-muted uppercase mr-2">{s.source}</span>
                  <span className="font-mono">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Etykieta</label>
        <input value={label} onChange={e => setLabel(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-3" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Komenda</label>
        <input value={command} onChange={e => setCommand(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-4 font-mono" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Anuluj</button>
          <button onClick={submit} disabled={!label.trim() || !command.trim()}
            className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium">Dodaj</button>
        </div>
      </div>
    </div>
  );
}
