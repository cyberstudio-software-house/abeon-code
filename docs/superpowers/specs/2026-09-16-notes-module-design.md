# AbeonCode — Notes Module Design

**Date:** 2026-09-16
**Status:** Approved (design) — pending spec review before planning
**Scope:** DesktopApp only

## Goal

Add a text notes module to AbeonCode with two scopes:

- project notes tied to the project from which the notes window was opened;
- global notes available from every project notes window.

The module opens in a separate Tauri window. It supports listing, creating,
viewing, editing, and deleting notes. Every note has a title and plain-text
content.

## Locked decisions

1. Notes are stored in the existing SQLite database.
2. A note has a separate title and content.
3. Saving is explicit through a `Zapisz` button; there is no autosave.
4. One notes window may be open per project. Reopening notes for the same
   project focuses the existing window.
5. The notes window uses a split layout: list on the left and editor on the
   right.
6. Unsaved changes are guarded when changing the selected note, switching
   scope, starting a new note, or closing the window.
7. Terminal and editor shortcuts remain in the left sidebar and are also
   available in the new right-panel toolbar.

## Entry point

Add a compact project toolbar above `ActionsSection` in the right panel. It is
bound to the project of the active tab and contains:

- `Terminal` — opens a new shell tab for the active project;
- `Edytor` — opens the active project in the configured external editor;
- `Notatki` — opens or focuses that project's notes window.

The existing terminal and editor buttons under expanded projects in the left
sidebar remain unchanged.

The right panel is already rendered only when a project tab is active in the
main window. Detached project and session windows also provide project context,
so the same toolbar works there.

## Window model

Extend the existing query-string window routing with:

```ts
type NotesWindowMode = {
  view: 'notes';
  projectId: number;
};
```

The window label is `notes-project-<projectId>`. The helper that opens the
window first calls `WebviewWindow.getByLabel`; an existing window receives
focus, otherwise a new window is created with a notes-specific URL. The Tauri
capability allowlist must include `notes-project-*` so IPC works in this window.

`App.tsx` routes notes mode to a dedicated `NotesShell`. It uses the existing
theme and custom titlebar but does not mount the normal three-column shell,
session state, terminal processes, or right panel.

The notes window opens at 920 × 680 px with a minimum size of 720 × 520 px.

## Persistence model

Add migration `005_notes.sql`:

```sql
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_notes_project_updated
  ON notes(project_id, updated_at DESC, id DESC);
```

Scope is represented by `project_id`:

- `NULL` — global note;
- a project id — project note.

Deleting a project therefore deletes its project notes through the foreign key,
while global notes remain. Timestamps use Unix milliseconds. Lists are ordered
by `updated_at DESC, id DESC` for deterministic newest-first ordering.

## Domain and IPC contract

Define the Rust `Note` domain type with `#[derive(TS)]` and export its generated
TypeScript definition with the existing `ts-rs` workflow.

The Tauri API exposes:

- `list_notes(project_id: Option<i64>) -> Vec<Note>`;
- `create_note(project_id: Option<i64>, title: String, content: String) -> Note`;
- `update_note(id: i64, title: String, content: String) -> Note`;
- `delete_note(id: i64) -> ()`.

`project_id = None` requests the global scope. Project-scoped creation verifies
that the project exists. Creation and updates trim the title for validation and
reject an empty result. Empty content is allowed. Updating and deleting an
unknown note returns `AppError::NotFound`. A missing project and a blank title
return `AppError::InvalidInput`.

All frontend calls go through typed wrappers in `src/lib/tauri.ts`; components
do not call `invoke` directly.

## Notes window UI

The top bar contains:

- tabs `Projektowe` and `Globalne`;
- a `+ Nowa notatka` button.

`Projektowe` is active on initial open. Changing tabs loads that scope and
clears the selection after the unsaved-change guard succeeds.

### Left list

Each row displays:

- title;
- a one-line content preview;
- formatted last-modified time;
- `Otwórz` action;
- delete action.

The list does not auto-select a note on startup. `Otwórz` selects it and fills
the editor. Deleting any row requires confirmation. After deleting the selected
note, the first note in the refreshed list is selected; if the list is empty,
the editor returns to its empty state.

Empty scopes show a short empty state and retain the create button.

### Right editor

With no selection, the editor area explains that the user can open an existing
note or create a new one. `+ Nowa notatka` opens a local blank draft. No database
row is created until the first successful save.

The editor contains:

- title input;
- plain-text multiline content field;
- `Zapisz` button;
- delete action for an existing note.

Saving a draft creates a note. Saving an existing note updates it. After a
successful save, the editor uses the returned database value, becomes clean,
and the updated note moves to the top of the list. A failed save preserves all
entered values and shows an error toast.

## Unsaved-change guard

Editor state keeps a saved snapshot and current values. It is dirty when either
the title or content differs from the snapshot.

When dirty, these actions require confirmation before discarding changes:

- opening another note;
- switching between project and global tabs;
- creating a new draft;
- deleting the currently edited note through another list action;
- closing the notes window.

The confirmation asks whether to discard unsaved changes. Cancel keeps the
current editor and selection unchanged. Confirm continues the pending action.

Window closing follows the established detached-window pattern: intercept
`onCloseRequested`, call `preventDefault`, render `ConfirmDialog`, and use
`destroy()` only after the user confirms. A clean window closes normally.

The guard does not offer implicit saving because explicit save is a locked UX
decision.

## Deletion flow

Every deletion requires a dedicated confirmation naming the note. Confirmation
calls the backend and updates the list only after success. Failure leaves the
note and editor intact and shows an error toast.

If deletion was requested while the selected note contains unsaved changes,
the discard confirmation runs before the delete confirmation. This keeps the
two decisions explicit: discard edits, then permanently delete the record.

## Multiple windows

Different project windows may show the same global notes. The first version does
not provide live cross-window synchronization or conflict detection. Lists are
refreshed after mutations performed in their own window, and the last
successful save is authoritative.

## Error handling

- Window creation failure shows a Polish error toast and leaves the current
  application state unchanged.
- List loading failure shows an error state with a retry action.
- Create/update/delete failures preserve the current list and editor state and
  show a Polish error toast.
- External editor launch failure is surfaced from the new toolbar instead of
  being logged only.
- A well-formed notes window URL whose project id no longer exists renders a
  safe error state and does not issue note mutations. Malformed or missing
  query parameters are rejected by the shared window-mode parser.

## Testing

### Rust

- migration creates the notes table and index;
- project and global CRUD round trips;
- scopes do not leak into one another;
- list ordering follows the latest update;
- blank titles are rejected and empty content is accepted;
- deleting a project cascades to project notes and preserves global notes;
- missing project and missing note errors are returned.

### Frontend

- notes window URL build/parse and label generation;
- opening focuses an existing project notes window;
- the project toolbar calls terminal, editor, and notes actions for the active
  project;
- initial project scope, tab changes, empty/loading/error states;
- creating a draft does not persist until save;
- editing and successful save update list order and clean state;
- validation and save failure preserve form values;
- deletion confirmation and backend failure behavior;
- every dirty-state transition is guarded;
- dirty window close uses the confirm-and-destroy path.

### Verification

Run from `DesktopApp/`:

```sh
npm test
npm run lint
npm run test:rust
```

## Out of scope

- Markdown or rich-text rendering;
- formatting toolbar;
- tags, folders, search, pinning, and attachments;
- autosave and draft persistence across app restarts;
- live synchronization or optimistic locking between notes windows;
- mobile or AbeonCloud access to notes;
- importing or exporting note files.
