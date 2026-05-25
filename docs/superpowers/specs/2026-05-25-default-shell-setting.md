# Default shell setting

## Problem

The interactive Shell PTY (a "terminal" tab) always spawns `bash`. Users whose login
shell is `zsh` (or `fish`, etc.) want their terminals to match their everyday shell.

## Scope

- **Affects only** `PtyKind::Shell` (interactive terminal tabs).
- **Does not affect** `PtyKind::Claude` or `PtyKind::Action` — both keep using
  `bash -lc <cmd>` as a stable command runner regardless of user preference.

## User-facing behavior

- Settings → "Ogólne" tab gains a "Domyślny shell" control.
- On first launch (no value persisted yet) the app auto-detects from `$SHELL` and
  stores it as the default.
- The user can override with a dropdown of detected shells (bash / zsh / fish / sh)
  or pick "Inny…" to paste a custom path (e.g. `/opt/homebrew/bin/fish`).
- A small hint reads: "Dotyczy tylko interaktywnych terminali (tab Shell)".

## Data model

One new persisted setting:

| Key         | Type   | Default | Meaning                                                    |
|-------------|--------|---------|------------------------------------------------------------|
| `shellPath` | string | `""`    | Empty = unresolved, fall back to `$SHELL`, then to `bash`. |

`shellPath` joins `PERSISTED_KEYS` in `src/store/index.ts` and gets a default
field in `settingsSlice.ts`.

## Backend

### New Tauri commands (`src-tauri/src/commands/settings.rs`)

```rust
#[tauri::command]
pub fn detect_default_shell() -> Option<String>;
// Reads $SHELL. If set and the file exists, returns the value.
// Otherwise returns None.

#[tauri::command]
pub fn list_available_shells() -> Vec<ShellInfo>;
// For each candidate in ["bash", "zsh", "fish", "sh"], probes `which <name>`.
// Returns entries with { name, path } for shells that resolve.
```

`ShellInfo` is a new `domain` struct with `#[derive(TS)]` so it crosses the IPC
boundary as a generated TS type.

### PTY change (`src-tauri/src/commands/pty.rs:64`)

Only the `PtyKind::Shell` arm changes:

```rust
PtyKind::Shell => {
    let shell = resolve_shell(&state)?;   // settings → $SHELL → "bash"
    (shell, vec!["-l".to_string()])
}
```

`resolve_shell` reads `shellPath` from the settings table; if empty, falls back
to `std::env::var("SHELL")`; if that fails, falls back to `"bash"`.

The `-l` (login) flag is honored by bash, zsh, and fish, so it stays.

## Frontend

### IPC wrappers (`src/lib/tauri.ts`)

```ts
export const detectDefaultShell = () =>
  invoke<string | null>('detect_default_shell');

export const listAvailableShells = () =>
  invoke<ShellInfo[]>('list_available_shells');
```

### Store (`src/store/settingsSlice.ts` + `src/store/index.ts`)

- Add `shellPath: string` (default `""`) to the slice.
- Add `'shellPath'` to `PERSISTED_KEYS`.
- After SQLite hydration completes: if the resolved value is still empty,
  call `detectDefaultShell()` once and persist the result.

### UI (`src/components/dialogs/SettingsDialog.tsx`)

In the "Ogólne" tab, between Theme and Skip Permissions, add a row:

- `<select>` populated from `listAvailableShells()` plus a final
  `"Inny…"` option.
- Picking "Inny…" reveals a text input bound to `shellPath`.
- Below the control: small muted hint with the auto-detected value
  ("Wykryto: zsh") and the scope note.

## Edge cases

| Situation                                  | Behavior                                       |
|--------------------------------------------|------------------------------------------------|
| `$SHELL` unset on first launch             | Persisted value stays `""`; spawn uses `bash`. |
| User saves a path that no longer exists    | Spawn fails; error surfaces in the xterm view. |
| User picks "Inny…" then leaves field empty | Treated as unresolved → fallback chain.        |
| Existing users (no `shellPath` in SQLite)  | Auto-detected once on next launch.             |

## Out of scope

- Per-project shell override (single global setting only).
- Customizing shell args (`-l` is hardcoded).
- Changing the shell used by Claude/Action PTYs.
- Validating that the chosen binary is actually a shell.

## Test plan

- Unit (Rust): `detect_default_shell` returns `Some` when `$SHELL` points to an
  existing file; `None` when unset or pointing to a missing file.
- Unit (Rust): `list_available_shells` returns at least `bash` in CI.
- Manual: on a machine where `$SHELL=/usr/bin/zsh`, fresh install → Settings
  shows "Wykryto: zsh", new Shell PTY runs zsh, Claude PTY still runs bash.
- Manual: change to fish via dropdown → next Shell PTY runs fish; existing
  Shell PTYs are unaffected (spawn-time decision).
