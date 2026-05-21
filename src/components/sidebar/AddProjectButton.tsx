import { useState } from 'react';
import { AddProjectDialog } from '../dialogs/AddProjectDialog';

export function AddProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="w-full mt-3 py-2 text-sm border border-dashed border-border rounded text-muted hover:text-fg hover:border-fg">
        + Dodaj projekt
      </button>
      {open && <AddProjectDialog onClose={() => setOpen(false)} />}
    </>
  );
}
