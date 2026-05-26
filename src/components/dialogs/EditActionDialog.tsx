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

  const submit = async () => {
    await tauri.updateAction(action.id, {
      label: label.trim(),
      command: command.trim(),
      workingDir: workingDir.trim() || null,
    });
    onUpdated();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[480px]">
        <h2 className="text-[14px] font-semibold mb-3">Edytuj akcję</h2>
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Etykieta</label>
        <input value={label} onChange={e => setLabel(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-3" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Komenda</label>
        <input value={command} onChange={e => setCommand(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-3 font-mono" />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Katalog roboczy</label>
        <input value={workingDir} onChange={e => setWorkingDir(e.target.value)}
          placeholder="(katalog projektu)"
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-4 font-mono text-muted placeholder:text-muted/50" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Anuluj</button>
          <button onClick={submit} disabled={!label.trim() || !command.trim()}
            className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium">Zapisz</button>
        </div>
      </div>
    </div>
  );
}
