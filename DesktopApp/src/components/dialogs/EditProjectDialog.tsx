import { useState } from 'react';
import type { Project } from '../../types';
import { useStore } from '../../store';
import { PROJECT_COLORS } from '../../lib/projectColors';
import { DeployFlowSection } from '../deploy/DeployFlowSection';

type Props = { project: Project; onClose: () => void };

export function EditProjectDialog({ project, onClose }: Props) {
  const updateProject = useStore(s => s.updateProject);
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState<string | null>(project.color);

  const submit = async () => {
    await updateProject(project.id, { name: name.trim(), color: color ?? '' });
    onClose();
  };

  return (
    <div className="dialog-backdrop">
      <div role="dialog" aria-modal="true" className="dialog-panel p-5 w-[560px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] flex flex-col">
        <h2 className="text-[14px] font-semibold mb-3">Edytuj projekt</h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 -mx-1.5">
          <label htmlFor="edit-project-name" className="block text-[10px] text-muted uppercase tracking-wider mb-1">Nazwa</label>
          <input
            id="edit-project-name"
            value={name}
            onChange={e => setName(e.target.value)}
            className="field mb-3"
          />
          <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Kolor</label>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <button
              type="button"
              aria-label="Kolor automatyczny"
              aria-pressed={color === null}
              onClick={() => setColor(null)}
              className={`h-5 px-2 rounded-full text-[10px] leading-none border transition-transform ${color === null ? 'ring-2 ring-offset-2 ring-offset-bg-elev ring-fg scale-110 border-transparent text-fg' : 'border-border text-muted'}`}
            >
              Auto
            </button>
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
          <DeployFlowSection projectId={project.id} />
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <button onClick={onClose} className="btn-secondary">Anuluj</button>
          <button onClick={submit} disabled={!name.trim()} className="btn-primary">Zapisz</button>
        </div>
      </div>
    </div>
  );
}
