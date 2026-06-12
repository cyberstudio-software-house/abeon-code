# Project Edit/Delete Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Edytuj (edit name + color) and Usuń (delete) to each project row in the sidebar, reachable via a kebab button and a right-click context menu.

**Architecture:** A new `ProjectManageMenu` dropdown (separate from the script-running `ProjectActionsMenu`) opened from a kebab button or `onContextMenu` on the project row. Edit opens a new `EditProjectDialog`; delete routes through the existing `ConfirmDialog`. A new `updateProject` store action mirrors the existing `removeProject`. The stored-but-unrendered `Project.color` becomes visible as a small dot on the row. No Rust changes — `tauri.updateProject` / `tauri.removeProject` and `store.removeProject` already exist.

**Tech Stack:** React 19, Zustand 5, Tailwind 4, Vitest + @testing-library/react.

All paths below are relative to `DesktopApp/`. Run all commands from `DesktopApp/`.

---

### Task 1: `updateProject` store action

**Files:**
- Modify: `src/store/projectsSlice.ts`
- Test: `src/store/projectsSlice.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/store/projectsSlice.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from './index';
import { tauri } from '../lib/tauri';
import type { Project } from '../types';

function fakeProject(id: number, name: string, color: string | null = null): Project {
  return { id, name, path: `/p/${id}`, claudeDir: `-p-${id}`, color, sortOrder: id, createdAt: 0 };
}

describe('projectsSlice updateProject', () => {
  beforeEach(() => { useStore.setState({ projects: [fakeProject(1, 'alpha'), fakeProject(2, 'beta')] }); });

  it('replaces the edited project with the backend-returned value', async () => {
    vi.spyOn(tauri, 'updateProject').mockResolvedValue(fakeProject(2, 'beta-renamed', '#b78640'));
    await useStore.getState().updateProject(2, { name: 'beta-renamed', color: '#b78640' });
    expect(tauri.updateProject).toHaveBeenCalledWith(2, { name: 'beta-renamed', color: '#b78640' });
    const beta = useStore.getState().projects.find(p => p.id === 2);
    expect(beta).toEqual(fakeProject(2, 'beta-renamed', '#b78640'));
    expect(useStore.getState().projects.find(p => p.id === 1)?.name).toBe('alpha');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/projectsSlice.test.ts`
Expected: FAIL — `updateProject` is not a function on the store state.

- [ ] **Step 3: Add the action to the slice**

In `src/store/projectsSlice.ts`, add to the `ProjectsSlice` type (after the `removeProject` line):

```ts
  updateProject: (id: number, patch: { name?: string; color?: string }) => Promise<void>;
```

And add the implementation to the returned object (after the `removeProject` implementation):

```ts
  updateProject: async (id, patch) => {
    const updated = await tauri.updateProject(id, patch);
    set({ projects: get().projects.map(p => (p.id === id ? updated : p)) });
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/projectsSlice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/projectsSlice.ts src/store/projectsSlice.test.ts
git commit -m "feat(projects): add updateProject store action"
```

---

### Task 2: Color preset constant

**Files:**
- Create: `src/lib/projectColors.ts`
- Test: `src/lib/projectColors.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/projectColors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PROJECT_COLORS } from './projectColors';

describe('PROJECT_COLORS', () => {
  it('is a non-empty list of unique hex colors', () => {
    expect(PROJECT_COLORS.length).toBeGreaterThan(0);
    expect(new Set(PROJECT_COLORS).size).toBe(PROJECT_COLORS.length);
    for (const c of PROJECT_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/projectColors.test.ts`
Expected: FAIL — cannot find module `./projectColors`.

- [ ] **Step 3: Create the constant**

Create `src/lib/projectColors.ts`:

```ts
export const PROJECT_COLORS = [
  '#b78640',
  '#c2483d',
  '#4a9d5b',
  '#4a7dc2',
  '#8b5cc2',
  '#6b7280',
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/projectColors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/projectColors.ts src/lib/projectColors.test.ts
git commit -m "feat(projects): add project color presets"
```

---

### Task 3: `ProjectManageMenu` component

**Files:**
- Create: `src/components/sidebar/ProjectManageMenu.tsx`
- Test: `src/components/sidebar/ProjectManageMenu.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/sidebar/ProjectManageMenu.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectManageMenu } from './ProjectManageMenu';

describe('ProjectManageMenu', () => {
  it('renders edit and delete items', () => {
    render(<ProjectManageMenu onEdit={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Edytuj')).toBeInTheDocument();
    expect(screen.getByText('Usuń')).toBeInTheDocument();
  });

  it('fires onEdit then onClose when Edytuj is clicked', () => {
    const onEdit = vi.fn(); const onClose = vi.fn();
    render(<ProjectManageMenu onEdit={onEdit} onDelete={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByText('Edytuj'));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fires onDelete then onClose when Usuń is clicked', () => {
    const onDelete = vi.fn(); const onClose = vi.fn();
    render(<ProjectManageMenu onEdit={() => {}} onDelete={onDelete} onClose={onClose} />);
    fireEvent.click(screen.getByText('Usuń'));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/sidebar/ProjectManageMenu.test.tsx`
Expected: FAIL — cannot find module `./ProjectManageMenu`.

- [ ] **Step 3: Create the component**

Create `src/components/sidebar/ProjectManageMenu.tsx`:

```tsx
import { Icon } from '../shared/Icon';

type Props = { onEdit: () => void; onDelete: () => void; onClose: () => void };

export function ProjectManageMenu({ onEdit, onDelete, onClose }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        onClick={() => { onEdit(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
        <span>Edytuj</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onDelete(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-danger hover:bg-danger/10"
      >
        <Icon name="trash" className="w-3 h-3" strokeWidth={2} />
        <span>Usuń</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/sidebar/ProjectManageMenu.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/ProjectManageMenu.tsx src/components/sidebar/ProjectManageMenu.test.tsx
git commit -m "feat(projects): add project manage menu (edit/delete)"
```

---

### Task 4: `EditProjectDialog` component

**Files:**
- Create: `src/components/dialogs/EditProjectDialog.tsx`
- Test: `src/components/dialogs/EditProjectDialog.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/components/dialogs/EditProjectDialog.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Project } from '../../types';

const h = vi.hoisted(() => ({ state: {} as Record<string, unknown>, update: vi.fn() }));
vi.mock('../../store', () => ({ useStore: (sel: (s: unknown) => unknown) => sel(h.state) }));

import { EditProjectDialog } from './EditProjectDialog';

const project: Project = {
  id: 3, name: 'gamma', path: '/p/3', claudeDir: '-p-3', color: null, sortOrder: 3, createdAt: 0,
};

describe('EditProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.update.mockResolvedValue(undefined);
    h.state = { updateProject: h.update };
  });

  it('pre-fills the name from the project', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    expect((screen.getByLabelText('Nazwa') as HTMLInputElement).value).toBe('gamma');
  });

  it('disables Zapisz when the name is empty', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: '  ' } });
    expect(screen.getByText('Zapisz')).toBeDisabled();
  });

  it('saves the trimmed name and selected color, then closes', async () => {
    const onClose = vi.fn();
    render(<EditProjectDialog project={project} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: '  gamma2  ' } });
    fireEvent.click(screen.getByLabelText('Kolor #b78640'));
    fireEvent.click(screen.getByText('Zapisz'));
    expect(h.update).toHaveBeenCalledWith(3, { name: 'gamma2', color: '#b78640' });
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('omits color from the patch when none is selected', () => {
    render(<EditProjectDialog project={project} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Zapisz'));
    expect(h.update).toHaveBeenCalledWith(3, { name: 'gamma' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/dialogs/EditProjectDialog.test.tsx`
Expected: FAIL — cannot find module `./EditProjectDialog`.

- [ ] **Step 3: Create the component**

Create `src/components/dialogs/EditProjectDialog.tsx`:

```tsx
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
          aria-label="Nazwa"
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
              onClick={() => setColor(prev => (prev === c ? null : c))}
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/dialogs/EditProjectDialog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dialogs/EditProjectDialog.tsx src/components/dialogs/EditProjectDialog.test.tsx
git commit -m "feat(projects): add edit project dialog (name + color)"
```

---

### Task 5: Wire the menu, context menu, color dot, and dialogs into `ProjectItem`

**Files:**
- Modify: `src/components/sidebar/ProjectItem.tsx`

This task is JSX wiring verified by `npm run lint` and the existing/new unit tests; there is no new unit test for `ProjectItem` (it would require heavy store mocking for little value). Verify behavior manually with `npm run tauri dev` at the end.

- [ ] **Step 1: Add imports**

At the top of `src/components/sidebar/ProjectItem.tsx`, alongside the existing imports, add:

```tsx
import { ProjectManageMenu } from './ProjectManageMenu';
import { EditProjectDialog } from '../dialogs/EditProjectDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
```

- [ ] **Step 2: Add state, ref, store action, and close-on-outside-click effect**

Inside the `ProjectItem` component, after the existing `menuRef` declaration (`const menuRef = useRef<HTMLDivElement | null>(null);`), add:

```tsx
  const [manageOpen, setManageOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const manageRef = useRef<HTMLDivElement | null>(null);
  const removeProject = useStore(s => s.removeProject);
```

After the existing `useEffect` that closes the actions menu (the one depending on `[menuOpen]`), add a second effect for the manage menu:

```tsx
  useEffect(() => {
    if (!manageOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (manageRef.current && !manageRef.current.contains(e.target as Node)) setManageOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [manageOpen]);
```

- [ ] **Step 3: Add the right-click handler and color dot to the header button**

Replace the opening of the header `<button>` (currently `onClick={() => toggle(project.id)}`) so it also handles right-click — change that button's props to:

```tsx
        onClick={() => toggle(project.id)}
        onContextMenu={(e) => { e.preventDefault(); setManageOpen(true); }}
```

Then, inside that button, replace the name `<div className="min-w-0 flex-1">` block with a version that shows the color dot:

```tsx
        <div className="min-w-0 flex-1 flex items-center gap-1.5">
          {project.color && (
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: project.color }} />
          )}
          <div className={`text-[12.5px] truncate ${expanded ? 'font-semibold text-fg' : 'font-medium text-fg'}`}>
            {project.name}
          </div>
        </div>
```

- [ ] **Step 4: Add the kebab button + manage menu next to the Actions menu**

In the expanded row, immediately after the closing `</div>` of the existing actions-menu container (the `<div className="relative" ref={menuRef}>...</div>` block, right before `<SessionList .../>`'s parent closes — i.e. as the last child of the `flex items-center gap-1` row), add:

```tsx
            <div className="relative" ref={manageRef}>
              <button
                onClick={(e) => { e.stopPropagation(); setManageOpen(o => !o); }}
                className="flex items-center gap-1 px-1.5 py-1.5 text-[11.5px] text-muted hover:text-fg transition-colors rounded"
                title="Zarządzaj projektem"
              >
                <Icon name="more" className="w-3 h-3" strokeWidth={2} />
              </button>
              {manageOpen && (
                <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-border bg-bg shadow-lg">
                  <ProjectManageMenu
                    onEdit={() => setEditing(true)}
                    onDelete={() => setConfirmingDelete(true)}
                    onClose={() => setManageOpen(false)}
                  />
                </div>
              )}
            </div>
```

- [ ] **Step 5: Render the dialogs**

Immediately before the closing `</li>` of the component's returned JSX, add:

```tsx
      {editing && <EditProjectDialog project={project} onClose={() => setEditing(false)} />}
      {confirmingDelete && (
        <ConfirmDialog
          title="Usuń projekt"
          message={`Usunąć projekt „${project.name}"? Tej operacji nie można cofnąć.`}
          onConfirm={() => { void removeProject(project.id); setConfirmingDelete(false); }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
```

- [ ] **Step 6: Type-check and run the full suite**

Run: `npm run lint`
Expected: zero errors.

Run: `npm test`
Expected: all tests pass (including the three new files).

- [ ] **Step 7: Manual verification**

Run: `npm run tauri dev`. In the sidebar:
- Right-click a project row → manage menu appears (no native menu).
- Expand a project → kebab (`more`) button appears beside the Actions button → opens the same menu.
- Edytuj → dialog opens pre-filled; change name + pick a color → Zapisz → name updates and a color dot appears on the row.
- Usuń → ConfirmDialog → confirm → project disappears from the list.

- [ ] **Step 8: Commit**

```bash
git add src/components/sidebar/ProjectItem.tsx
git commit -m "feat(projects): add edit/delete context menu to project list"
```

---

## Notes for the implementer

- The Rust backend `update_project` treats an absent `color` as "leave unchanged" and cannot clear a color back to NULL; that is why the dialog has no "remove color" option and the patch omits `color` when nothing is selected. This is intentional and in scope per the design.
- The actions menu (`layers` icon, `ProjectActionsMenu`) and the new manage menu (`more` icon, `ProjectManageMenu`) are deliberately separate — one runs scripts, the other edits/deletes the project. Keep their open-state and refs independent so they don't close each other.
- User-facing strings stay Polish; identifiers stay English (repo convention).
