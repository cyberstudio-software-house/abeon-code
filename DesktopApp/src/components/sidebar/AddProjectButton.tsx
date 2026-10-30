import { useState } from 'react';
import { AddProjectDialog } from '../dialogs/AddProjectDialog';

export function AddProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="w-full py-2 text-[11.5px] rounded-lg border border-dashed border-border-strong text-label hover:text-fg-strong hover:border-fg-secondary transition-colors">
        + Dodaj projekt
      </button>
      {open && <AddProjectDialog onClose={() => setOpen(false)} />}
    </>
  );
}
