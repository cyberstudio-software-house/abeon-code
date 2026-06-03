import { useState } from 'react';
import type { Project } from '../../types';
import { useStore } from '../../store';
import { PROJECT_COLORS } from '../../lib/projectColors';

type Props = { project: Project; onClose: () => void };

export function EditProjectDialog({ project, onClose }: Props) {
  const updateProject = useStore(s => s.updateProject);
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState<string | null>(project.color);

  const submit = async () => {
    const patch: { name?: string; color?: string } = { name: name.trim() };
    if (color) patch.color = color;
    await updateProject(project.id, patch);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[400px]">
        <h2 className="text-[14px] font-semibold mb-3">Edytuj projekt</h2>
        <label htmlFor="edit-project-name" className="block text-[10px] text-muted uppercase tracking-wider mb-1">Nazwa</label>
        <input
          id="edit-project-name"
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full bg-bg border border-border px-3 py-1.5 text-[13px] mb-3"
        />
        <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Kolor</label>
        <div className="flex items-center gap-2 mb-4">
          {PROJECT_COLORS.map(c => (
            <button
              key={c}
              type="button"
              aria-label={`Kolor ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
              className={`w-5 h-5 rounded-full transition-transform ${color === c ? 'ring-2 ring-offset-2 ring-offset-bg-elev ring-fg scale-110' : ''}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Anuluj</button>
          <button onClick={submit} disabled={!name.trim()} className="px-3 py-1.5 bg-fg text-bg text-[12px] font-medium disabled:opacity-50">Zapisz</button>
        </div>
      </div>
    </div>
  );
}
