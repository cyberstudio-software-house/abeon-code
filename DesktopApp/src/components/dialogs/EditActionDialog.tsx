import { useState } from 'react';
import type { Action } from '../../types';
import { tauri } from '../../lib/tauri';

type Props = {
  action: Action;
  onClose: () => void;
  onUpdated: () => void;
};

export function EditActionDialog({ action, onClose, onUpdated }: Props) {
  const [label, setLabel] = useState(action.label);
  const [command, setCommand] = useState(action.command);
  const [workingDir, setWorkingDir] = useState(action.workingDir ?? '');
  const [preCommand, setPreCommand] = useState(action.preCommand ?? '');

  const submit = async () => {
    await tauri.updateAction(action.id, {
      label: label.trim(),
      command: command.trim(),
      workingDir: workingDir.trim() || null,
      preCommand: preCommand.trim() || null,
    });
    onUpdated();
    onClose();
  };

  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" className="dialog-panel p-5 w-[480px]">
        <h2 className="text-[14px] font-semibold mb-3">Edytuj akcję</h2>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Etykieta</label>
        <input value={label} onChange={e => setLabel(e.target.value)}
          className="field mb-3" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Komenda</label>
        <input value={command} onChange={e => setCommand(e.target.value)}
          className="field mb-3 font-mono" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Katalog roboczy</label>
        <input value={workingDir} onChange={e => setWorkingDir(e.target.value)}
          placeholder="(katalog projektu)"
          className="field mb-3 font-mono text-muted placeholder:text-muted/50" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Komenda przygotowująca</label>
        <input value={preCommand} onChange={e => setPreCommand(e.target.value)}
          placeholder="np. nvm use 18"
          className="field mb-1 font-mono placeholder:text-muted/50" />
        <p className="text-[10px] text-muted mb-4">
          Wykonywana przed komendą. Użyteczne dla <code className="font-mono">nvm use X</code> / <code className="font-mono">fnm use X</code>. Bez końcowego <code className="font-mono">&amp;&amp;</code>.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Anuluj</button>
          <button onClick={submit} disabled={!label.trim() || !command.trim()}
            className="btn-primary">Zapisz</button>
        </div>
      </div>
    </div>
  );
}
