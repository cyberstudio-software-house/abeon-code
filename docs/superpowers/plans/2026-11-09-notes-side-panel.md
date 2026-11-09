# Notes in the right panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate notes window with a notes mode of the right panel (tiles → full-panel editor with autosave), add a `note` centre-tab kind, drop note titles, and let Claude sessions add and read notes through `abeon-code note` and an `abeon-notes` skill.

**Architecture:** A new Zustand `notesSlice` owns everything stateful: the panel mode, the note lists per scope, and one draft per note (keyed by a client UUID, looked up by `noteId`) with a debounced, per-draft serialised autosave. The panel editor and note tabs are thin views over those drafts. Rust drops the title (column kept, always `''`), makes notes commands async and emits `notes://changed`. A headless `abeoncode note add|list` subcommand writes/reads SQLite directly and pings the running app over the existing supervisor socket.

**Tech Stack:** Tauri 2, Rust (rusqlite 0.37 bundled, ts-rs, tokio Unix socket), React 19, Zustand 5, Tailwind 4, Vitest + Testing Library, bash wrapper script.

**Spec:** `docs/superpowers/specs/2026-11-08-notes-side-panel-design.md`

## Global Constraints

- All paths below are relative to `DesktopApp/` unless they start with `docs/`.
- UI text in Polish, identifiers in English, **no code comments**.
- Every IPC call goes through `src/lib/tauri.ts`; IPC types are ts-rs exported from Rust (run `cargo test` in `src-tauri` to regenerate `src/types/*.ts`; never hand-edit them).
- Notes commands are `#[tauri::command(async)]`; nothing new may run blocking work on the GTK main thread.
- Note tab layers follow the `PaneLayout` rules (never change DOM parent, keep relative order).
- No new window labels.
- Verification commands: `npm run lint` (zero errors), `npx vitest run --maxWorkers=3 <files>` (plain `npm test` flakes under load), `cd src-tauri && cargo test <filter>`.
- Commits: Conventional Commits, scope `desktop`, committed directly on local `main`, no co-author trailer and no `Claude-Session` line.

## Review Focus

1. Text typed less than the debounce (700 ms) before „← Notatki”, ✕, closing the tab or the window must still be saved — pinned in Task 2 (`backToNotesList flushes pending text immediately`) and Task 5.
2. Typing while the first save of a new note is still in flight must update that note, not create a second one — pinned in Task 2 (`edits during an in-flight create update the created note`).
3. Closing one view of a note that another view still shows (panel + tab) must neither delete an emptied note nor drop the draft — pinned in Task 4 (`release keeps a draft another view still shows`).
4. `abeon-code note` from a subdirectory of nested projects, or through a symlinked path, must pick the closest registered project — pinned in Task 7 (`resolves the closest ancestor project`, `resolves through symlinks`).
5. Note text with Polish characters, leading/trailing blank lines and a line that looks like a delimiter must round-trip through the CLI intact (trimmed only at the ends) — pinned in Task 7 (`add trims only the ends and keeps unicode`).

---

### Task 1: Untitled notes data layer and removal of the notes window

**Files:**
- Create: `src-tauri/src/db/migrations/007_notes_untitled.sql`
- Modify: `src-tauri/src/db/mod.rs`, `src-tauri/src/db/notes_repo.rs`, `src-tauri/src/domain/note.rs`, `src-tauri/src/commands/notes.rs`, `src-tauri/src/lib.rs` (register `get_note`), `src/lib/tauri.ts`, `src/App.tsx`, `src/lib/windowMode.ts`, `src/lib/windowMode.test.ts`, `src/components/layout/DetachedShell.tsx`, `src/components/right/ProjectToolbar.tsx`, `src/components/right/ProjectToolbar.test.tsx`, `src-tauri/capabilities/default.json`
- Delete: `src/components/notes/` (all files), `src/lib/openNotesWindow.ts`, `src/lib/openNotesWindow.test.ts`
- Test: `src-tauri/src/db/mod.rs` (tests module), `src-tauri/src/db/notes_repo.rs` (tests module)

**Interfaces:**
- Produces (Rust): `notes_repo::create(conn, project_id: Option<i64>, content: &str) -> AppResult<Note>` (rejects whitespace-only content with `AppError::InvalidInput("treść jest wymagana")`), `notes_repo::update(conn, id: i64, content: &str) -> AppResult<Note>` (accepts any content, including empty), `notes_repo::get`, `notes_repo::list`, `notes_repo::delete` unchanged in shape. Commands `list_notes`, `get_note(id)`, `create_note(project_id, content)`, `update_note(id, content)`, `delete_note(id)`.
- Produces (TS): `Note = { id: number; projectId: number | null; content: string; createdAt: number; updatedAt: number }`; `tauri.listNotes(projectId: number | null): Promise<Note[]>`, `tauri.getNote(id: number): Promise<Note>`, `tauri.createNote(projectId: number | null, content: string): Promise<Note>`, `tauri.updateNote(id: number, content: string): Promise<Note>`, `tauri.deleteNote(id: number): Promise<void>`.

- [ ] **Step 1: Write the failing Rust tests**

In `db/mod.rs` tests (seed an old database with raw `Connection::open` + the earlier migration constants, as `upgrades_existing_v4_database_and_preserves_data_on_reopening` does):

```rust
#[test]
fn migration_007_folds_titles_into_content_and_keeps_order() {
    // seed v6 (MIGRATION_001..006), insert rows (id, title, content, updated_at):
    // (1,'Plan','Treść',5), (2,'Tylko tytuł','',6), (3,'   ','Bez tytułu',7)
    // init_pool(&path)
    assert_eq!(version, 7);
    assert_eq!(content_of(1), "Plan\nTreść");
    assert_eq!(content_of(2), "Tylko tytuł");
    assert_eq!(content_of(3), "Bez tytułu");
    assert!(all_titles_empty);
    assert_eq!(updated_at_of(1..=3), [5, 6, 7]);
}

#[test]
fn concurrent_first_open_of_an_old_database_succeeds_everywhere() {
    // seed v4 as in the existing upgrade test, then 4 threads call init_pool(&path)
    assert!(results.iter().all(Result::is_ok));
    assert_eq!(version, 7);
}
```

Update `upgrades_existing_v4_database_and_preserves_data_on_reopening` to expect version `7`. In `notes_repo.rs` replace the title-based tests with:

```rust
#[test] fn create_rejects_blank_content()            // create(&conn, None, " \n\t") -> Err(InvalidInput), COUNT(*) == 0
#[test] fn create_stores_an_empty_title_column()     // SELECT title FROM notes WHERE id=? == ""
#[test] fn update_accepts_empty_content()            // update(&conn, id, "") -> Ok, content == ""
#[test] fn update_missing_note_is_not_found()        // update(&conn, 404, "x") -> Err(NotFound); delete(404) -> Err(NotFound)
```

Keep `separates_global_and_project_notes`, `updates_and_orders_by_latest_change`, `breaks_equal_timestamp_ties_by_descending_id_in_both_scopes`, `cascades_project_notes_only`, `rejects_missing_project_without_creating_a_note` with the new signatures (assert on `content` instead of `title`).

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test db::`
Expected: compile errors / FAIL (`MIGRATION_007` missing, old `create` arity).

- [ ] **Step 3: Implement the migration and the transactional runner**

`007_notes_untitled.sql`:

```sql
UPDATE notes SET content = CASE
  WHEN trim(title, ' ' || char(9) || char(10) || char(13)) = '' THEN content
  WHEN content = '' THEN title
  ELSE title || char(10) || content
END;
UPDATE notes SET title = '';
INSERT OR IGNORE INTO schema_version(version) VALUES (7);
```

`run_migrations` takes a mutable pooled connection, opens `conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)`, runs `MIGRATION_001`, reads the version **inside** the transaction, applies `002..007` as today plus `if v < 7`, then commits. The `title` column is not dropped.

- [ ] **Step 4: Implement the untitled repo, domain type and async commands**

`Note` loses `title`. Repo selects `id,project_id,content,created_at,updated_at`, inserts `title` as `''`. Commands get `#[tauri::command(async)]`; add `get_note(state, id: i64) -> AppResult<Note>` and register it in `lib.rs`.

- [ ] **Step 5: Run the Rust tests**

Run: `cd src-tauri && cargo test db:: && cargo test notes`
Expected: PASS; `src/types/Note.ts` regenerated without `title`.

- [ ] **Step 6: Remove the notes window and rewire the frontend API**

Delete the files listed above. In `windowMode.ts` drop `NotesWindowMode`, `parseNotesMode`, the `notes` branch, `buildNotesWindowUrl`, `notesWindowLabel`; drop the `notes window mode` describe block from `windowMode.test.ts`. `App.tsx` renders `windowMode ? <DetachedShell mode={windowMode} /> : <AppShell />`; `DetachedShell` takes `mode: WindowMode`. Remove `"notes-project-*"` from `capabilities/default.json`. Update the `tauri.ts` notes wrappers to the signatures above. `ProjectToolbar` temporarily drops the „Notatki” button (grid `grid-cols-2`); Task 3 brings it back. Update `ProjectToolbar.test.tsx` accordingly (no `openNotesWindow` mock).

- [ ] **Step 7: Verify the frontend**

Run: `npm run lint && npx vitest run --maxWorkers=3 src/lib src/components/right src/components/layout`
Expected: zero lint errors; tests PASS. `grep -rn "openNotesWindow\|NotesShell\|notes-project\|view: 'notes'" src src-tauri/capabilities` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A src-tauri/src/db src-tauri/src/domain/note.rs src-tauri/src/commands/notes.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json src/types/Note.ts src/lib src/App.tsx src/components/notes src/components/layout/DetachedShell.tsx src/components/right/ProjectToolbar.tsx src/components/right/ProjectToolbar.test.tsx
git commit -m "refactor(desktop): drop note titles and the separate notes window"
```

---

### Task 2: Note text helpers and the notes store

**Files:**
- Create: `src/lib/noteText.ts`, `src/lib/noteText.test.ts`, `src/store/notesSlice.ts`, `src/store/notesSlice.test.ts`
- Modify: `src/store/index.ts` (compose the slice into `AppState`; add a subscriber that calls `closeNotesPanel()` when `notesPanelOpen` and `activeTabId` changes to `null`)

**Interfaces:**
- Consumes: Task 1 `tauri` notes wrappers and `Note`.
- Produces (`src/lib/noteText.ts`):
  - `isBlankNote(content: string): boolean`
  - `noteTitle(content: string): string`: first non-blank line, trimmed, cut to `NOTE_TITLE_MAX = 40` chars plus `…`; blank content → `'Pusta notatka'`.
  - `type NotesListKey = 'global' | \`project:${number}\``; `notesListKey(projectId: number | null): NotesListKey`
  - `formatNoteDate(timestamp: number, now: number): string` with month abbreviations `['sty','lut','mar','kwi','maj','cze','lip','sie','wrz','paź','lis','gru']`: same day `dziś, HH:MM`, previous day `wczoraj, HH:MM`, same year `D mmm, HH:MM`, other year `D mmm YYYY, HH:MM` (local time, two-digit hours/minutes).
- Produces (`src/store/notesSlice.ts`):

```ts
export const NOTE_SAVE_DEBOUNCE_MS = 700;
export type NotesScope = 'project' | 'global';
export type NotesList = { status: 'loading' | 'ready' | 'error'; notes: Note[] };
export type NoteSaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type NoteDraft = { key: string; noteId: number | null; projectId: number | null; content: string; savedContent: string; status: NoteSaveStatus };
export type NotesView = { mode: 'list' } | { mode: 'editor'; draftKey: string };
export type DraftHolder = 'panel' | { tabId: string };

export type NotesSlice = {
  notesPanelOpen: boolean;
  notesScope: NotesScope;
  notesView: NotesView;
  notesLists: Partial<Record<NotesListKey, NotesList>>;
  noteDrafts: Record<string, NoteDraft>;
  openNotesPanel: () => void;
  closeNotesPanel: () => Promise<boolean>;
  setNotesScope: (scope: NotesScope) => void;
  loadNotes: (projectId: number | null) => Promise<void>;
  reloadNotes: () => Promise<void>;
  startNewNote: (projectId: number | null) => void;
  openNoteInPanel: (note: Note) => void;
  ensureNoteDraft: (noteId: number) => Promise<string | null>;
  backToNotesList: () => Promise<boolean>;
  editNoteDraft: (key: string, content: string) => void;
  flushNoteDraft: (key: string) => Promise<boolean>;
  retryNoteDraft: (key: string) => void;
  discardNoteDraft: (key: string) => void;
  releaseNoteDraft: (key: string, from: DraftHolder) => Promise<boolean>;
  deleteNoteById: (noteId: number) => Promise<boolean>;
  flushAllNoteDrafts: () => Promise<boolean>;
};
export function draftKeyForNote(state: Pick<NotesSlice, 'noteDrafts'>, noteId: number): string | null;
export function hasUnsavedNotes(state: Pick<NotesSlice, 'noteDrafts'>): boolean;
```

Semantics the implementer cannot infer:
- Draft keys are `crypto.randomUUID()`; an existing note's draft is found by `noteId` (`draftKeyForNote`), so the panel and tabs share it. `openNoteInPanel` / `ensureNoteDraft` reuse an existing draft; `ensureNoteDraft` loads via `tauri.getNote` when none exists (returns `null` on error).
- Saves run per draft through a module-level promise chain (`Map<string, Promise<void>>`) and module-level debounce timers (`Map<string, ReturnType<typeof setTimeout>>`), not in state. A save snapshots `content`: `noteId === null` → `createNote(projectId, content)` (skipped while blank), else `updateNote(noteId, content)`; on success set `noteId`, `savedContent = snapshot`, `status = content === snapshot ? 'saved' : 'idle'` and upsert the returned note into its list (sorted `updatedAt` desc, then `id` desc); on failure `status = 'error'` with the content kept.
- `flushNoteDraft` clears the timer, enqueues a save if dirty, awaits the chain and returns `status !== 'error'`.
- `releaseNoteDraft(key, from)`: another holder exists when `from !== 'panel'` and the panel editor shows `key` (Task 4 adds note tabs as holders). With another holder: flush and return its result. Without: if the content is blank, cancel the timer, skip saving, `deleteNote(noteId)` when it has one and remove it from its list; otherwise flush and return `false` on failure (draft kept). Drop the draft on success.
- `backToNotesList` / `closeNotesPanel` release the panel draft with `'panel'`, and only on `true` switch to `{ mode: 'list' }` (and close the panel). They do not toast; the UI does.
- `discardNoteDraft` only applies to drafts with `noteId === null`: drops it, clears its timer, returns the panel to the list.
- `deleteNoteById` calls `tauri.deleteNote`, removes the note from every list, drops its drafts and timers and switches the panel to the list if it showed it (Task 4 adds closing the note's tabs). Returns `false` on IPC failure.
- `reloadNotes` re-fetches every loaded list without setting `loading`, and replaces the content of drafts that are clean (`content === savedContent`, status not `saving`) with the fetched note (falling back to `tauri.getNote` for drafts whose list is not loaded; errors ignored).
- `hasUnsavedNotes`: any draft with status `saving`, or `content !== savedContent` unless it is a blank draft without `noteId`.

- [ ] **Step 1: Write the failing helper tests** (`noteText.test.ts`)

```ts
expect(noteTitle('\n  Klient chce CSV  \nreszta')).toBe('Klient chce CSV');
expect(noteTitle('a'.repeat(50))).toBe('a'.repeat(40) + '…');
expect(noteTitle(' \n ')).toBe('Pusta notatka');
expect(isBlankNote(' \t\n')).toBe(true);
expect(notesListKey(4)).toBe('project:4'); expect(notesListKey(null)).toBe('global');
const now = new Date(2026, 10, 9, 18, 0).getTime();
expect(formatNoteDate(new Date(2026, 10, 9, 14, 32).getTime(), now)).toBe('dziś, 14:32');
expect(formatNoteDate(new Date(2026, 10, 8, 16, 47).getTime(), now)).toBe('wczoraj, 16:47');
expect(formatNoteDate(new Date(2026, 10, 3, 9, 12).getTime(), now)).toBe('3 lis, 09:12');
expect(formatNoteDate(new Date(2025, 10, 3, 9, 12).getTime(), now)).toBe('3 lis 2025, 09:12');
```

- [ ] **Step 2: Write the failing store tests** (`notesSlice.test.ts`, real `useStore`, `vi.mock('../lib/tauri')` keeping the other wrappers, `vi.useFakeTimers()`, reset notes state in `beforeEach`)

```ts
it('debounces edits and creates the note once')            // startNewNote(2); edit 'A'; edit 'AB'; advance 699 → createNote not called; advance 1 → createNote(2,'AB') once; draft.noteId set, status 'saved'
it('never stores a blank new note')                        // startNewNote(2); edit '  '; await flushNoteDraft → createNote not called
it('edits during an in-flight create update the created note') // createNote deferred; edit 'A'; advance 700; edit 'AB'; resolve {id:9, content:'A'}; await flush → createNote once, updateNote(9,'AB')
it('backToNotesList flushes pending text immediately')     // openNoteInPanel(n5 'X'); edit 'XY'; await backToNotesList() (no timer advance) → updateNote(5,'XY'); view list; draft gone
it('a failed save keeps the text and the editor')          // updateNote rejects; edit 'XY'; backToNotesList() resolves false; view still editor; draft.status 'error', content 'XY'; retryNoteDraft + updateNote resolves → status 'saved'
it('releasing an emptied note deletes it')                 // openNoteInPanel(n5); edit ''; backToNotesList() → deleteNote(5), updateNote not called, n5 removed from lists['project:2']
it('saved notes move to the top of their list')            // loadNotes(2) → [n7(updatedAt 30), n5(20)]; edit n5; flush (updateNote returns updatedAt 40) → order [5,7]
it('deleteNoteById removes the note from lists and the panel') // panel on n5; deleteNoteById(5) → deleteNote(5), n5 gone from lists, draft gone, view list
it('reloadNotes refreshes lists and only clean drafts')    // dirty draft of 5 keeps its text; clean draft of 7 gets the fetched content
it('hasUnsavedNotes tracks dirty and saving drafts')       // true after edit, true while saving, false after flush
it('the panel closes when no tab is left')                 // openNotesPanel(); setState({ tabs: [], activeTabId: null }) → notesPanelOpen false
```

- [ ] **Step 3: Run them and see them fail**

Run: `npx vitest run --maxWorkers=3 src/lib/noteText.test.ts src/store/notesSlice.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `noteText.ts`, `notesSlice.ts` and compose it in `store/index.ts`**

- [ ] **Step 5: Run the tests and lint**

Run: `npx vitest run --maxWorkers=3 src/lib/noteText.test.ts src/store && npm run lint`
Expected: PASS, zero lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/noteText.ts src/lib/noteText.test.ts src/store/notesSlice.ts src/store/notesSlice.test.ts src/store/index.ts
git commit -m "feat(desktop): add a notes store with per-note drafts and autosave"
```

---

### Task 3: Notes panel in the right panel

**Files:**
- Create: `src/components/notes/NotesPanel.tsx`, `src/components/notes/NoteTiles.tsx`, `src/components/notes/NoteEditor.tsx`, `src/components/notes/NotesPanel.test.tsx`, `src/components/right/RightPanel.test.tsx`
- Modify: `src/components/right/RightPanel.tsx`, `src/components/right/ProjectToolbar.tsx`, `src/components/right/ProjectToolbar.test.tsx`

**Interfaces:**
- Consumes: Task 2 slice, `noteText` helpers, `ConfirmDialog`, `Icon` names `notebook`, `plus`, `close`, `arrowLeft`, `trash`.
- Produces: `NoteEditor({ draftKey, variant }: { draftKey: string; variant: 'panel' | 'tab' })`: textarea (`aria-label="Treść notatki"`, placeholder `Zacznij pisać…`, focused on mount with the caret at the end, every change → `editNoteDraft`) plus the status line: `saving` → `Zapisywanie…`, `saved` → `✓ Zapisano`, `error` → `Nie udało się zapisać` and a button `Ponów` (→ `retryNoteDraft`), `idle` → nothing. `variant: 'tab'` uses a centred column `max-w-[72ch]` and `text-[14px]`; `'panel'` fills the width with `text-[13px]`. Task 4 reuses it.

Layout and copy (mockup variant A; tokens from the Grafit theme):
- List view: bar with label `Notatki`, accent button `+ Nowa` (`aria-label="Nowa notatka"`), icon button `aria-label="Zamknij panel notatek"`; scope switch `role="tablist" aria-label="Zakres notatek"` with tabs `Projektowe` / `Globalne`; tiles in one scrolling column. Tile = button with the content (`whitespace-pre-line line-clamp-4`) and a `<time>` from `formatNoteDate(updatedAt, Date.now())`. States: `Ładowanie notatek…`, `Nie udało się wczytać notatek.` + `Spróbuj ponownie`, `Brak notatek projektowych` / `Brak notatek globalnych`.
- The list shows `notesLists[notesListKey(scope === 'project' ? activeProjectId : null)]` and calls `loadNotes` when that key changes and has no entry.
- `+ Nowa` → `startNewNote(scope === 'project' ? activeProjectId : null)`.
- Editor view: bar with `← Notatki` (`aria-label="Wróć do listy notatek"`) and a trash icon button `aria-label="Usuń notatkę"`; then `NoteEditor variant="panel"`. Delete on a saved note → `ConfirmDialog` title `Usuń notatkę`, message `Usunąć tę notatkę? Tej operacji nie można cofnąć.`, confirm `Usuń` → `deleteNoteById`; on an unsaved new note → `discardNoteDraft` directly.
- Any store call that resolves `false` (`backToNotesList`, `closeNotesPanel`, `deleteNoteById`) shows `toast.error('Nie udało się zapisać notatki')` (`'Nie udało się usunąć notatki'` for delete).
- `RightPanel`: when `notesPanelOpen`, render `NotesPanel` and keep the toolbar and every section mounted inside a wrapper with `hidden` and `inert`; otherwise the wrapper is visible and `NotesPanel` is not rendered.
- `ProjectToolbar`: „Notatki” button back (`grid-cols-3`), `onClick={openNotesPanel}`.

- [ ] **Step 1: Write the failing component tests** (mock `../../store` with a selector over `mockState`, as `GitSection.test.tsx` does)

```ts
it('shows project notes as tiles and opens one')        // tile text 'Klient chce CSV…', time 'dziś, 14:32' (fake system time); click → openNoteInPanel(note)
it('creates a note in the selected scope')               // '+ Nowa' → startNewNote(4); switch to 'Globalne' → setNotesScope('global'); with scope global → startNewNote(null)
it('loads the list for the visible scope once')          // notesLists empty → loadNotes(4) called once
it('shows the empty and error states')                   // 'Brak notatek projektowych'; status error → 'Spróbuj ponownie' → loadNotes(4)
it('edits a note with a focused textarea')               // editor view: textarea has focus and value; typing 'X' → editNoteDraft(key,'…X')
it('shows the save status')                              // saving → 'Zapisywanie…'; saved → '✓ Zapisano'; error → 'Ponów' → retryNoteDraft(key)
it('asks before deleting a saved note')                  // trash → dialog 'Usuń notatkę' → 'Usuń' → deleteNoteById(5)
it('discards an unsaved new note without asking')        // noteId null → trash → discardNoteDraft(key), no dialog
it('warns when leaving fails')                           // backToNotesList resolves false → toast.error('Nie udało się zapisać notatki')
```

`RightPanel.test.tsx`: `it('keeps the sections mounted while notes are open')`: stub `GitSection` with a mount counter; toggle `notesPanelOpen` true → false; mount count stays `1`, the stub is hidden while notes are open. `ProjectToolbar.test.tsx`: „Notatki” → `openNotesPanel` called.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --maxWorkers=3 src/components/notes src/components/right/RightPanel.test.tsx src/components/right/ProjectToolbar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `NoteTiles`, `NoteEditor`, `NotesPanel`, and the `RightPanel` / `ProjectToolbar` changes**

- [ ] **Step 4: Run the tests and lint**

Run: `npx vitest run --maxWorkers=3 src/components/notes src/components/right && npm run lint`
Expected: PASS, zero lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/notes src/components/right
git commit -m "feat(desktop): open notes as tiles and an autosaving editor in the right panel"
```

---

### Task 4: Note tabs in the centre

**Files:**
- Create: `src/components/notes/NoteTabView.tsx`, `src/components/notes/NoteTabView.test.tsx`
- Modify: `src/store/tabsSlice.ts`, `src/store/tabsSlice.test.ts`, `src/store/notesSlice.ts`, `src/store/notesSlice.test.ts`, `src/lib/windowMode.ts`, `src/lib/detachGroup.ts`, `src/lib/detachGroup.test.ts`, `src/components/center/TabContent.tsx`, `src/components/center/TabContent.test.tsx`, `src/components/center/TabItem.tsx`, `src/components/center/TabContextMenu.tsx`, `src/components/center/useTabBarActions.tsx`, `src/components/center/PaneBar.tsx`, `src/components/notes/NotesPanel.tsx`, `src/components/notes/NotesPanel.test.tsx`

**Interfaces:**
- Consumes: Task 2 slice (`flushNoteDraft`, `releaseNoteDraft`, `ensureNoteDraft`, `deleteNoteById`, `draftKeyForNote`), Task 3 `NoteEditor`.
- Produces:
  - `Tab` gains `{ kind: 'note'; id: string; projectId: number; noteId: number; title: string }`; `noteTabId(noteId: number): string` → `` `note:${noteId}` ``.
  - `TabsSlice.openNoteTab(noteId: number, projectId: number, title: string): void`: activates an existing `noteTabId(noteId)` tab, otherwise appends and activates it (same `mruOrder` / `withNav` / `closedSupervisorPanel` handling as `openNewTerminalTab`).
  - `NotesSlice.openNoteInTab(key: string): Promise<boolean>`: flushes; `false` when it fails or the draft still has no `noteId` (blank new note); tab `projectId` = the draft's `projectId` for a project note, else the active tab's `projectId`; title `noteTitle(content)`; if the panel showed this key it switches to `{ mode: 'list' }` without releasing (the tab now holds the draft).
  - `editNoteDraft` (and a successful create) also sets `title = noteTitle(content)` on every note tab with that `noteId`.
  - `releaseNoteDraft` also counts open note tabs with the draft's `noteId` (other than `from.tabId`) as holders; `deleteNoteById` also closes every note tab with that `noteId` (via `closeTab`).
  - `DetachedTab` gains `{ kind: 'note'; id: string; noteId: number; title: string }`; `buildDetachPayload` and `tabsFromGroupMode` map it explicitly. `detachProjectGroup` gets an extra argument `flushNotes: () => Promise<boolean>`; when it resolves `false` it shows `toast.error('Nie udało się zapisać notatki')` and does not detach. `useTabBarActions.runDetach` passes `useStore.getState().flushAllNoteDrafts`.

UI and behaviour:
- `TabPanel` renders `<NoteTabView tab={tab} visible={visible} focused={focused} />` inside `layer(visible)` for `kind === 'note'`.
- `NoteTabView` calls `ensureNoteDraft(tab.noteId)` on mount; while it resolves shows `Wczytywanie notatki…`, on `null` shows `Nie udało się wczytać notatki.`. Header row: label `Notatka projektowa` / `Notatka globalna`, trash button (same dialog and copy as Task 3; on confirm `deleteNoteById`, which closes the tab). Body: `NoteEditor variant="tab"`.
- `TabItem` marker for notes: `Icon name="notebook"`.
- No rename for note tabs: `TabContextMenu` gets `canRename: boolean` and hides `Zmień nazwę` when false; `PaneBar` does not start renaming a note tab.
- Closing a note tab (X, middle click, Ctrl/Cmd+W, menu): `useTabBarActions.doClose` for `kind === 'note'` awaits `releaseNoteDraft(draftKeyForNote(state, noteId), { tabId })` (skip when no draft) and calls `closeTab` only on `true`; on `false` `toast.error('Nie udało się zapisać notatki')`. No confirmation dialog.
- `NotesPanel` editor bar gains a `toTab` icon button `aria-label="Otwórz w zakładce"`, disabled while the draft is blank and has no `noteId`, → `openNoteInTab(key)` (toast on `false` only when the draft is not blank).

- [ ] **Step 1: Write the failing tests**

```ts
// tabsSlice.test.ts
it('openNoteTab opens once and re-activates')                 // twice with noteId 5 → one tab 'note:5', active, mruOrder[0] 'note:5'
it('tabsFromGroupMode keeps note tabs')                        // { kind:'note', id:'note:5', noteId:5, title:'X' } → kind 'note', projectId from mode
// detachGroup.test.ts
it('buildDetachPayload keeps note tabs')                       // note tab → { kind:'note', id, noteId, title }
it('does not detach when notes cannot be saved')               // flushNotes resolves false → no WebviewWindow created, detachTabs not called
// notesSlice.test.ts
it('openNoteInTab saves a new note first and opens its tab')   // startNewNote(2); edit 'Klient\nx'; openNoteInTab(key) → createNote called, tab note:<id> title 'Klient' projectId 2; panel view list; draft kept
it('openNoteInTab puts a global note in the active project')   // active tab projectId 3, draft projectId null → tab projectId 3
it('editing renames the note tab')                             // edit 'Nowy tytuł\n…' → tab.title 'Nowy tytuł'
it('closing the last view of an emptied note deletes it')      // tab only; edit ''; releaseNoteDraft(key,{tabId:'note:5'}) → deleteNote(5)
it('release keeps a draft another view still shows')           // panel editor on n5 + tab note:5; edit ''; releaseNoteDraft(key,'panel') → deleteNote not called, draft kept; releaseNoteDraft(key,{tabId:'note:5'}) with the panel still on it → same
it('deleteNoteById closes the note tabs')                      // tab note:5 open; deleteNoteById(5) → no tab with id 'note:5'
// TabContent.test.tsx
it('renders a note tab with its editor')                       // ensureNoteDraft resolves key → textarea 'Treść notatki' present
// NoteTabView.test.tsx
it('shows the scope and deletes after confirmation')           // 'Notatka globalna' for projectId null draft; trash → 'Usuń' → deleteNoteById(5)
it('reports a note that cannot be loaded')                     // ensureNoteDraft → null → 'Nie udało się wczytać notatki.'
// NotesPanel.test.tsx
it('opens the note in a tab')                                  // 'Otwórz w zakładce' → openNoteInTab(key); disabled for a blank new draft
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --maxWorkers=3 src/store src/lib/detachGroup.test.ts src/components/center src/components/notes`
Expected: FAIL.

- [ ] **Step 3: Implement the tab kind, slice actions, detach mapping, views and tab-bar changes**

- [ ] **Step 4: Run the tests and lint**

Run: `npx vitest run --maxWorkers=3 src/store src/lib src/components/center src/components/notes && npm run lint`
Expected: PASS, zero lint errors (the new union member surfaces every missed `kind` switch as a type error; fix each).

- [ ] **Step 5: Commit**

```bash
git add src/store src/lib/windowMode.ts src/lib/detachGroup.ts src/lib/detachGroup.test.ts src/components/center src/components/notes
git commit -m "feat(desktop): open notes as centre tabs"
```

---

### Task 5: Save notes before a window closes or the app relaunches

**Files:**
- Modify: `src/components/layout/AppShell.tsx`, `src/components/layout/AppShellLifecycle.test.tsx`, `src/components/layout/DetachedShell.tsx`, `src/components/layout/DetachedShell.test.tsx`

**Interfaces:**
- Consumes: `hasUnsavedNotes(state)`, `flushAllNoteDrafts()` (Task 2).

Behaviour (both shells):
- `onCloseRequested`: if `hasUnsavedNotes(state)` → `event.preventDefault()` (synchronously) and run `flushAllNoteDrafts()`. On `true` continue with today's logic: live processes → the existing process `ConfirmDialog`; none → `getCurrentWebviewWindow().destroy()`. On `false` show `ConfirmDialog` title `Nie udało się zapisać notatki`, message `Zamknięcie okna spowoduje utratę niezapisanej treści notatki.`, confirm `Zamknij mimo to` → continue with the process logic; cancel keeps the window.
- With no unsaved notes the close path is exactly today's.
- `AppShell.runUpdate`: after `downloadAndInstall` and before `relaunch()`, `await flushAllNoteDrafts()`; on `false` → `toast.error('Nie udało się zapisać notatki — ponowne uruchomienie wstrzymane')`, reset the busy state, do not relaunch.

- [ ] **Step 1: Write the failing tests** (extend the existing `close guard` describe blocks)

```ts
it('saves pending notes before closing')                 // dirty draft; close requested → preventDefault, updateNote called, then destroy()
it('asks before closing when a note cannot be saved')    // updateNote rejects → dialog 'Nie udało się zapisać notatki'; 'Zamknij mimo to' → destroy(); cancel → no destroy
it('saves notes and then asks about running sessions')   // dirty draft + live session → after flush the process dialog appears
it('does not relaunch when notes cannot be saved')       // AppShell only: update flow with failing flush → relaunch not called, toast.error with the copy above
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --maxWorkers=3 src/components/layout`
Expected: FAIL.

- [ ] **Step 3: Implement the close and relaunch flushes**

- [ ] **Step 4: Run the tests and lint**

Run: `npx vitest run --maxWorkers=3 src/components/layout && npm run lint`
Expected: PASS, zero lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout
git commit -m "fix(desktop): save notes before closing a window or relaunching"
```

---

### Task 6: Notes change events across windows and from outside the app

**Files:**
- Modify: `src-tauri/src/domain/note.rs`, `src-tauri/src/commands/notes.rs`, `src-tauri/src/supervisor/ipc.rs`, `src-tauri/src/supervisor/runtime.rs`, `src/lib/tauri.ts`, `src/components/layout/AppShell.tsx`, `src/components/layout/DetachedShell.tsx`
- Create: `src/lib/useNotesSync.ts`, `src/lib/useNotesSync.test.ts`

**Interfaces:**
- Produces (Rust):
  - `NotesChangedEvent { created_note_id: Option<i64>, external: bool, source_window: Option<String> }`, ts-rs exported, `#[serde(rename_all = "camelCase")]`, emitted to all webviews as `notes://changed`.
  - `create_note`, `update_note`, `delete_note` take `window: tauri::WebviewWindow` and, after success, emit `{ created_note_id: None, external: false, source_window: Some(window.label()) }`.
  - `IpcRequest::NotesChanged { #[serde(default)] created_note_id: Option<i64> }` (wire: `{"type":"notesChanged","created_note_id":7}`) and `IpcResponse::Ack` (wire: `{"type":"ack"}`). `IpcRouter` gets an `app: AppHandle` field (filled in `spawn_ipc`); `route` answers `NotesChanged` by emitting `{ created_note_id, external: true, source_window: None }` and returning `Ack`.
- Produces (TS): `tauri.onNotesChanged(cb: (event: NotesChangedEvent) => void): Promise<UnlistenFn>`; `useNotesSync(): void`, mounted once in `AppShell` and once in `DetachedShell`: ignores events whose `sourceWindow` equals `getCurrentWebviewWindow().label`, otherwise calls `reloadNotes()`; additionally, only in the window labelled `main`, `external && createdNoteId != null` → `toast.success('Dodano notatkę')`.

- [ ] **Step 1: Write the failing tests**

```rust
// supervisor/ipc.rs tests
#[test] fn notes_changed_request_round_trips()   // serde_json::to_value(NotesChanged{created_note_id:Some(7)}) == json!({"type":"notesChanged","created_note_id":7}); parse back equals; parse {"type":"notesChanged"} → created_note_id None
#[test] fn ack_response_serializes()             // to_value(IpcResponse::Ack) == json!({"type":"ack"})
```

```ts
// useNotesSync.test.ts (mock tauri.onNotesChanged capturing cb, getCurrentWebviewWindow().label, store, sonner)
it('reloads notes on changes from another window')        // sourceWindow 'project-3', own 'main' → reloadNotes called, no toast
it('ignores its own changes')                             // sourceWindow 'main', own 'main' → reloadNotes not called
it('announces a note added from outside in the main window only') // external, createdNoteId 7 → toast.success('Dodano notatkę') in 'main'; none in 'project-3' (reload in both)
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test supervisor::ipc` and `npx vitest run --maxWorkers=3 src/lib/useNotesSync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the event type, command emits, IPC variant and router branch**

Add the new match arms the closed enums now require (the `StubHandler` in `ipc.rs` tests answers `NotesChanged` with `Ack`).

- [ ] **Step 4: Implement `tauri.onNotesChanged` and `useNotesSync`, mount it in both shells**

- [ ] **Step 5: Run the tests and lint**

Run: `cd src-tauri && cargo test supervisor && cargo test notes`, then `npx vitest run --maxWorkers=3 src/lib src/components/layout && npm run lint`
Expected: PASS; `src/types/NotesChangedEvent.ts` generated; zero lint errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/domain/note.rs src-tauri/src/commands/notes.rs src-tauri/src/supervisor/ipc.rs src-tauri/src/supervisor/runtime.rs src/types/NotesChangedEvent.ts src/lib/tauri.ts src/lib/useNotesSync.ts src/lib/useNotesSync.test.ts src/components/layout
git commit -m "feat(desktop): refresh notes when another window or the CLI changes them"
```

---

### Task 7: `abeon-code note` command

**Files:**
- Create: `src-tauri/src/cli/notes.rs`
- Modify: `src-tauri/src/cli/mod.rs` (`pub mod notes;`), `src-tauri/src/lib.rs` (`run()`), `src-tauri/src/cli/installer.rs`

**Interfaces:**
- Consumes: `notes_repo`, `projects_repo::list`, `db::{db_path, init_pool}`, `supervisor::ipc::{request_blocking, socket_path, IpcRequest::NotesChanged}` (Task 6, `#[cfg(unix)]` only).
- Produces (`cli/notes.rs`):

```rust
pub const MAX_NOTE_BYTES: usize = 64 * 1024;
#[derive(Debug, PartialEq)] pub enum NoteAction { Add, List }
#[derive(Debug, PartialEq)] pub struct NoteCommand { pub action: NoteAction, pub global: bool, pub cwd: Option<PathBuf>, pub limit: Option<usize> }
pub fn parse(args: &[String]) -> Option<Result<NoteCommand, String>>;            // None unless args[1] == "note"
pub fn resolve_project<'a>(projects: &'a [Project], cwd: &Path) -> Option<&'a Project>;
pub fn add(conn: &Connection, cmd: &NoteCommand, input: &str) -> Result<(Note, String), String>;
pub fn list(conn: &Connection, cmd: &NoteCommand) -> Result<String, String>;
pub fn format_notes(notes: &[Note]) -> String;
pub fn try_run(args: &[String]) -> Option<i32>;
```

Exact behaviour and copy:
- Flags in any order after `add`/`list`: `--global`, `--cwd <dir>`, `--limit <N>` (`list` only, N ≥ 1). Anything else → `Err(USAGE)` with `USAGE = "usage: abeon-code note add [--global] <<'ABEON_NOTE_<hex>' … | abeon-code note list [--global] [--limit N]"`.
- Without `--global`, the project is the one whose canonical path (`std::fs::canonicalize`, falling back to the stored path when that fails) equals the canonical `--cwd` or is its closest ancestor (`Path::starts_with`, longest match). No match → `"{cwd} is not inside an AbeonCode project (use --global for a global note)"`. Missing `--cwd` without `--global` → `USAGE`.
- `add`: input trimmed at both ends (`str::trim`); empty → `"empty note"`; more than `MAX_NOTE_BYTES` → `"note too long ({n} bytes, max 65536)"`. Message: `"note added (id {id}) to project {name}"` or `"note added (id {id}) as a global note"`.
- `list`: notes newest first (repo order), at most `limit`; `format_notes` prints for each note `--- note {id} · {YYYY-MM-DD HH:MM} ---\n{content}\n` (local time from `updated_at`), notes separated by one blank line. Empty → `"no notes in project {name}"` / `"no global notes"`.
- `try_run`: `parse` → on `None` return `None`. Errors print `abeon-code: {msg}` to stderr and return `Some(2)`. `add` refuses a terminal stdin (`std::io::IsTerminal`) with `"expected the note on stdin (use a heredoc)"`, reads stdin to a string, opens `init_pool(&db_path()?)`, runs `add`, prints `abeon-code: {message}` to stdout, then (unix only) `request_blocking(&socket_path(), &IpcRequest::NotesChanged { created_note_id: Some(id) }, Duration::from_secs(2))` ignoring the result; returns `Some(0)`. `list` prints `list`'s output to stdout and returns `Some(0)`.
- `run()` in `lib.rs` calls `cli::notes::try_run` first, before the `#[cfg(unix)]` supervisor subcommands and before `diagnostics::init()`, exiting with its code.
- Wrapper (`installer.rs`): a line `wrapper_features="note"` right after `unset_args=(…)`, and before the `session` branch:

```bash
if [ "${1:-}" = "note" ]; then
  [ -x "$exe" ] || fail "AbeonCode executable not found: $exe (reinstall the command in AbeonCode settings)"
  shift
  exec env "${unset_args[@]}" "$exe" note "$@" --cwd "$(pwd -P)"
fi
```

- [ ] **Step 1: Write the failing tests** (`cli/notes.rs` tests with a temp-file pool; `installer.rs` tests with the existing `fake_exe`/`run_wrapper` harness)

```rust
#[test] fn parses_add_and_list_flags()                 // ["abeoncode","note","list","--limit","3","--cwd","/p"] → List, limit 3, cwd /p; ["…","note","add","--global"] → Add, global
#[test] fn rejects_unknown_flags_and_actions()         // "note","edit" and "note","add","--force" → Some(Err(USAGE)); ["abeoncode","/proj"] → None
#[test] fn resolves_the_closest_ancestor_project()     // projects /a and /a/b (real temp dirs); cwd /a/b/c → /a/b; cwd /a/x → /a; cwd /z → None
#[test] fn resolves_through_symlinks()                 // symlink /tmp/link → project dir; cwd link/sub → that project
#[test] fn add_trims_only_the_ends_and_keeps_unicode() // input "  \nZadzwonić do klienta – żółć\n\nABEON_NOTE_x\n\n" → stored "Zadzwonić do klienta – żółć\n\nABEON_NOTE_x"
#[test] fn add_rejects_empty_and_oversized_notes()     // "  \n" → "empty note"; 65537 bytes → "note too long (65537 bytes, max 65536)"; COUNT(*) == 0
#[test] fn add_outside_a_project_fails_unless_global() // cwd not in a project → Err containing "is not inside an AbeonCode project"; same with --global → Ok, project_id None, message "note added (id 1) as a global note"
#[test] fn list_prints_newest_first_with_limit()       // three notes, limit 2 → two "--- note" headers, newest first; empty project → "no notes in project Demo"
```

```rust
// installer.rs tests
#[test] fn wrapper_declares_the_note_feature()         // wrapper_script(..) contains "wrapper_features=\"note\""
#[test] fn note_branch_runs_synchronously_with_cwd()   // fake exe (no sleep) records args and stdin and exits 3; run_wrapper(["note","add","--global"], stdin "Treść") from a temp cwd → exit code 3, args == ["note","add","--global","--cwd",<canonical temp cwd>], recorded stdin "Treść", caller Claude env vars stripped
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd src-tauri && cargo test cli::`
Expected: FAIL.

- [ ] **Step 3: Implement `cli/notes.rs`, wire `run()`, extend the wrapper**

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test cli:: && cargo test db::`
Expected: PASS.

- [ ] **Step 5: Smoke-test the binary against a scratch database**

Run (from `src-tauri`, with a throwaway config dir so the real database is untouched): `XDG_CONFIG_HOME=$(mktemp -d) cargo run -q -- note add --global <<'X'` + a line of text + `X`, then `… cargo run -q -- note list --global` with the same `XDG_CONFIG_HOME`.
Expected: `abeon-code: note added (id 1) as a global note`, then one `--- note 1 · …` block; no window opens.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/cli src-tauri/src/lib.rs
git commit -m "feat(desktop): let agents add and read notes with abeon-code note"
```

---

### Task 8: `abeon-notes` skill, settings copy and docs

**Files:**
- Modify: `src-tauri/src/cli/skill.rs`, `src-tauri/src/commands/cli.rs`, `src/components/settings/categories/ProvidersCategory.tsx`, `src/lib/settingsCategories.ts`, `DesktopApp/CLAUDE.md`

**Interfaces:**
- Produces: `skill::install(skills_root: &Path) -> AppResult<Vec<PathBuf>>` writing `abeon-open-session/SKILL.md` (unchanged text) and `abeon-notes/SKILL.md`; `install_claude_skill` returns the skills root directory as a string (`Zainstalowano: ~/.claude/skills` in the existing status line).

`abeon-notes/SKILL.md` (exact text):

````markdown
---
name: abeon-notes
description: Add a note to, or read the notes of, the current project in AbeonCode (or the global notes). Use when the user asks to add, write down or save a note, or to read, check or act on their notes, e.g. "dodaj notatkę z informacją o…", "zanotuj, że…", "zapisz w notatkach", "przeczytaj notatki", "co zanotowałem po rozmowie z klientem", "zrób to, co jest w notatkach", "add a note", "read my notes".
---

# Notes in AbeonCode

AbeonCode keeps short plain-text notes per project, plus global notes. Notes have no titles: the
first line is what the user sees on the tile and in the tab, so start with the gist.

## Before the first call

Check that the installed `abeon-code` command supports notes:

```bash
grep -q 'wrapper_features=.*note' "$(command -v abeon-code)" && echo ok
```

No `ok` (or `command not found`): tell the user to reinstall it in AbeonCode → Ustawienia →
„Skill dla Claude Code” → „Zainstaluj skill”, and stop. Never call `abeon-code note` with an
outdated command: it would start the app instead.

## Add a note

Run exactly this with the Bash tool from the project's directory. Pick a fresh delimiter for every
call, `ABEON_NOTE_` followed by 8 random hex characters, keep it quoted, and never let a line of
the note equal it:

```bash
abeon-code note add <<'ABEON_NOTE_5b2e9c1d'
<note text>
ABEON_NOTE_5b2e9c1d
```

- Write the note in the user's language, as plain text.
- One note per request unless the user asks for more.
- Add `--global` only when the user says the note is global, not tied to this project.
- Success: exit code 0 and a line starting with `abeon-code: note added`. Tell the user in one line.

## Read notes

```bash
abeon-code note list
```

Prints the project's notes, newest first, each starting with a `--- note <id> · <date> ---` line.
Add `--global` for the global notes and `--limit N` for only the newest N. Read them before acting
on "what I noted"; if several notes could match, ask which one.

## Errors

A non-zero exit prints `abeon-code: …` on stderr. "is not inside an AbeonCode project" means the
current directory is not a project registered in AbeonCode: tell the user, or use `--global` if
they want a global note. You cannot edit or delete notes.
````

Settings copy (`ProvidersCategory` description of „Skill dla Claude Code”, and the matching `keywords` entry in `settingsCategories.ts`):
`Instaluje skille abeon-open-session i abeon-notes w ~/.claude/skills. Pozwalają agentowi uruchomić w tle nową sesję w innym projekcie z gotowym promptem („odpal sesję w ~/projects/x i dodaj endpoint…”) oraz dodawać i czytać notatki projektu („dodaj notatkę z informacją o…”, „przeczytaj notatki”). Instaluje też (aktualizuje) komendę abeon-code w ~/.local/bin, która musi być dostępna w PATH.`
Add the keywords `notatki`, `abeon-notes`.

`DesktopApp/CLAUDE.md`: a `## Notes` section (store-owned panel mode and drafts, one draft per note shared by panel and tabs, autosave chain and flush points, empty-note deletion on release, `note` tab kind not persisted, `notes://changed` and the CLI ping, the `title` column kept as `''` on purpose, the `wrapper_features` marker); mention `components/notes/` and `store/notesSlice.ts` in the folder map; add `note` to the tab kinds list in "Tabs system".

- [ ] **Step 1: Write the failing test**

```rust
// skill.rs
#[test] fn install_writes_both_skills_and_overwrites()  // paths == [root/abeon-open-session/SKILL.md, root/abeon-notes/SKILL.md]; stale files rewritten; notes skill starts with "---\nname: abeon-notes\n", contains "abeon-code note add", "wrapper_features=.*note", "<<'ABEON_NOTE_5b2e9c1d'", "--global", "You cannot edit or delete notes"
```

Keep the existing open-session content assertions.

- [ ] **Step 2: Run it and see it fail**

Run: `cd src-tauri && cargo test cli::skill`
Expected: FAIL.

- [ ] **Step 3: Implement the skill install, command return value, settings copy and docs**

- [ ] **Step 4: Full verification**

Run: `cd src-tauri && cargo test`, then `npm run lint && npx vitest run --maxWorkers=3`
Expected: everything PASS, zero lint errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cli/skill.rs src-tauri/src/commands/cli.rs src/components/settings/categories/ProvidersCategory.tsx src/lib/settingsCategories.ts CLAUDE.md
git commit -m "feat(desktop): install an abeon-notes skill for Claude sessions"
```
