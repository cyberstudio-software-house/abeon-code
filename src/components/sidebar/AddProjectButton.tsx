import { useState } from 'react';
import { AddProjectDialog } from '../dialogs/AddProjectDialog';

export function AddProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="w-full py-2 text-[11.5px] border border-dashed border-border text-muted hover:text-fg hover:border-fg-secondary">
        + Dodaj projekt
      </button>
      {open && <AddProjectDialog onClose={() => setOpen(false)} />}
    </>
  );
}
