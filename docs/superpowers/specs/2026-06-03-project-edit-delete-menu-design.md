# Project edit/delete context menu — design

**Date:** 2026-06-03
**Scope:** DesktopApp sidebar. Frontend + one store action only. No Rust changes.

## Goal

The project list lets users create projects but offers no way to edit or delete an
existing one. Add **Edytuj** (edit) and **Usuń** (delete) as a context menu on each
project row, reachable both via a kebab button and a right-click (PPM) context menu.

## Decisions

- **Trigger:** both a kebab (`more`) button in the expanded row *and* a right-click
  (`onContextMenu`) handler on the project header.
- **Placement:** a *separate* project-management menu, distinct from the existing
  `ProjectActionsMenu` (which manages a project's runnable scripts).
- **Edit scope:** project **name** + **color**.
- **Color clearing:** set-only. The backend `repo::update` treats `Option<color>` as
  "present → write, absent → unchanged" and cannot encode clear-to-NULL. Rather than
  change Rust, the editor only lets users pick/change among preset swatches; there is
  no "remove color" option.
- **Color visibility:** `Project.color` is stored but currently rendered nowhere. The
  row gains a small color dot before the name so a set color is actually visible.

## Existing capabilities reused

- `tauri.updateProject(id, { name?, color? })` and `tauri.removeProject(id)` already
  exist (`src/lib/tauri.ts`); `remove_project` cascade-deletes the project's actions.
- `store.removeProject(id)` already exists in `projectsSlice`.
- `ConfirmDialog` (`src/components/dialogs/ConfirmDialog.tsx`) for delete confirmation.
- Dropdown pattern (local `menuOpen` + `menuRef` + document `mousedown` close) from
  `ProjectItem.tsx` / `ProjectActionsMenu.tsx`.
- Edit-dialog layout from `EditActionDialog.tsx` (fixed overlay `z-50`, bordered box).

## Components

### `src/components/sidebar/ProjectManageMenu.tsx` (new)
- Props: `{ project: Project; onEdit: () => void; onDelete: () => void; onClose: () => void }`.
- `role="menu"`, `py-1` panel matching `ProjectActionsMenu` item styling.
- Item **Edytuj** — `pencil` icon, calls `onEdit()` then `onClose()`.
- Item **Usuń** — `trash` icon, `text-danger` + `hover:bg-danger/10`, calls `onDelete()`.

### `src/components/dialogs/EditProjectDialog.tsx` (new)
- Props: `{ project: Project; onClose: () => void }`.
- Mirrors `EditActionDialog` overlay/box (`w-[400px]`).
- **Nazwa** text input, pre-filled from `project.name`, required (empty disables Zapisz).
- **Kolor** row: a fixed set of ~6 preset swatch buttons; the one matching the current
  value (or current selection) shows a selection ring. No "none" option.
- Buttons: **Anuluj** (`onClose`) / **Zapisz** (`disabled` when name is empty).
- Save → `await store.updateProject(project.id, { name, color })` → `onClose()`.

### `src/store/projectsSlice.ts`
- Add `updateProject: (id: number, patch: { name?: string; color?: string }) => Promise<void>`
  to `ProjectsSlice`, mirroring `removeProject`: call `tauri.updateProject`, then replace
  the matching entry in `projects` with the returned `Project`.

### `src/components/sidebar/ProjectItem.tsx`
- Add a **kebab (`more`) button** beside the existing `layers` Actions button; its own
  `manageMenuOpen` state + `manageMenuRef` + document-`mousedown` close (same pattern as
  the existing actions menu — independent so they don't fight over one ref).
- Add `onContextMenu` on the header `<button>`: `e.preventDefault()` then open the same
  `ProjectManageMenu`.
- Render a color dot before the name when `project.color` is set:
  `<span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: project.color }} />`.
- Local state `editing` / `confirmingDelete`; conditionally render `EditProjectDialog`
  and `ConfirmDialog`.

## Flows

- **Edit:** open menu → Edytuj → `EditProjectDialog` → Zapisz → `store.updateProject`
  → list re-renders (new name / dot color).
- **Delete:** open menu → Usuń → `ConfirmDialog` (title "Usuń projekt", message
  `Usunąć projekt „<name>"? Tej operacji nie można cofnąć.`, danger confirm) →
  `store.removeProject(id)` → row disappears.

## Testing

- `npm run lint` → zero errors; `npm test` green.
- Vitest for `ProjectManageMenu`: renders both items and fires `onEdit` / `onDelete`.
- (If practical) a test asserting `store.updateProject` replaces the project in state
  with the backend-returned value.

## Out of scope

- Clearing a color back to none (would require a Rust change).
- Editing `path` / `claudeDir` (path is unique and tied to session storage).
- Reordering / multi-select operations.
