# `abeon-code` CLI Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shell command `abeon-code .` that opens the desktop app (focusing a running instance) and starts a new session in the matching project, creating the project if it does not exist.

**Architecture:** Two entry points — CLI argv (via `tauri-plugin-single-instance`) and a `abeon-code://` deep link (via `tauri-plugin-deep-link`) — converge on one Rust dispatcher that either buffers the path (cold start) or emits a `cli://open-path` event (warm start). The frontend resolves the path through a new `find_or_create_project` command and opens a session via the existing `openNewSessionTab`. A Settings button installs a thin wrapper script on PATH (VS Code style).

**Tech Stack:** Tauri 2, Rust, React 19, Zustand 5, Vitest, cargo test, rusqlite.

## Global Constraints

- Identifiers in English only; user-facing UI text in Polish.
- No code comments unless WHY is non-obvious (match existing code — it rarely has comments).
- Conventional Commits 1.0.0; **no co-author trailer**; scope `desktop`. Do **not** push.
- All commands run from `DesktopApp/`.
- `npm run lint` (= `tsc -b --noEmit`) must report zero errors.
- Every Rust command gets a matching wrapper in `src/lib/tauri.ts`; register the command in `src-tauri/src/lib.rs`.
- Rust tests: `npm run test:rust`. Frontend tests: `npm test`.
- Target is the **installed** app (Linux + macOS). Windows is out of scope.
- When the input is a file (not a directory) → error. No argument → wrapper defaults to `.`.

## File Structure

- Create `src-tauri/src/cli/mod.rs` — module root + runtime glue (`dispatch_open`, `scan_args_into_pending`).
- Create `src-tauri/src/cli/open_input.rs` — pure parser `parse_open_input` (+ percent-decode).
- Create `src-tauri/src/cli/installer.rs` — pure `wrapper_script` + `install`.
- Create `src-tauri/src/commands/cli.rs` — Tauri commands `take_pending_open_paths`, `install_cli_command`.
- Modify `src-tauri/src/db/projects_repo.rs` — add `get_by_path`.
- Modify `src-tauri/src/commands/projects.rs` — add `find_or_create` (free fn) + `find_or_create_project` command.
- Modify `src-tauri/src/state.rs` — add `pending_open_paths`, `cli_frontend_ready`.
- Modify `src-tauri/src/lib.rs` — register plugins, setup wiring, register commands, declare `pub mod cli;` + `commands::cli`.
- Modify `src-tauri/Cargo.toml` — add plugin deps.
- Modify `src-tauri/tauri.conf.json` — deep-link scheme.
- Modify `src-tauri/capabilities/default.json` — deep-link permission.
- Modify `src-tauri/src/commands/mod.rs` — declare `pub mod cli;`.
- Create `src/lib/openProject.ts` — frontend handler `openProjectPath`.
- Modify `src/lib/tauri.ts` — wrappers for the new commands + `onCliOpenPath`.
- Modify `src/store/index.ts` — drain pending paths on boot (main window only).
- Modify `src/components/layout/AppShell.tsx` — register `onCliOpenPath` listener.
- Modify `src/components/dialogs/SettingsDialog.tsx` — `CliCommandSection` in `CliTab`.
- Create `src/lib/openProject.test.ts` — frontend test.
- Modify `docs/superpowers/specs/2026-06-19-abeon-code-cli-launch-design.md` is the source spec (read-only here).

---

### Task 1: `projects_repo::get_by_path`

**Files:**
- Modify: `src-tauri/src/db/projects_repo.rs`
- Test: same file (`#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub fn get_by_path(conn: &Connection, path: &str) -> AppResult<Option<Project>>`

- [ ] **Step 1: Write the failing test**

Add inside the existing `mod tests` in `src-tauri/src/db/projects_repo.rs`:

```rust
    #[test]
    fn get_by_path_finds_and_misses() {
        let p = pool();
        let c = p.get().unwrap();
        insert(&c, "Demo", "/x/y", "-x-y", None).unwrap();
        let found = get_by_path(&c, "/x/y").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "Demo");
        assert!(get_by_path(&c, "/nope").unwrap().is_none());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rust -- get_by_path_finds_and_misses`
Expected: FAIL — `cannot find function get_by_path`.

- [ ] **Step 3: Write minimal implementation**

Add after `get` in `src-tauri/src/db/projects_repo.rs`:

```rust
pub fn get_by_path(conn: &Connection, path: &str) -> AppResult<Option<Project>> {
    let mut s = conn.prepare(
        "SELECT id,name,path,claude_dir,color,sort_order,created_at FROM projects WHERE path=?",
    )?;
    let mut rows = s.query(params![path])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_project(row)?)),
        None => Ok(None),
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rust -- get_by_path_finds_and_misses`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/projects_repo.rs
git commit -m "feat(desktop): add get_by_path lookup to projects repo"
```

---

### Task 2: `find_or_create_project` command

**Files:**
- Modify: `src-tauri/src/commands/projects.rs`
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src/lib/tauri.ts` (wrapper)
- Test: `src-tauri/src/commands/projects.rs`

**Interfaces:**
- Consumes: `repo::get_by_path` (Task 1), `encode_project_path`.
- Produces:
  - `pub fn find_or_create(conn: &Connection, input: &str) -> AppResult<Project>`
  - `#[tauri::command] pub fn find_or_create_project(state, path: String) -> AppResult<Project>`
  - `tauri.findOrCreateProject(path: string): Promise<Project>`

- [ ] **Step 1: Write the failing test**

Add a `#[cfg(test)] mod tests` block at the end of `src-tauri/src/commands/projects.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::{NamedTempFile, tempdir};

    fn conn() -> rusqlite::Connection {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap().get().unwrap()
    }

    #[test]
    fn creates_then_reuses_project() {
        let c = conn();
        let dir = tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();

        let a = find_or_create(&c, &path).unwrap();
        assert_eq!(a.name, dir.path().file_name().unwrap().to_string_lossy());

        let b = find_or_create(&c, &path).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(repo::list(&c).unwrap().len(), 1);
    }

    #[test]
    fn rejects_missing_and_file() {
        let c = conn();
        assert!(find_or_create(&c, "/definitely/not/here/xyz").is_err());

        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(find_or_create(&c, &file.to_string_lossy()).is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rust -- creates_then_reuses_project`
Expected: FAIL — `cannot find function find_or_create`.

- [ ] **Step 3: Write minimal implementation**

Add to `src-tauri/src/commands/projects.rs` (the `use` lines already import `AppError`, `AppResult`, `encode_project_path`, `repo`, `Project`, `State`, `AppState`):

```rust
pub fn find_or_create(conn: &rusqlite::Connection, input: &str) -> AppResult<Project> {
    let canonical = std::fs::canonicalize(input).map_err(|_| AppError::InvalidPath {
        path: input.to_string(),
        reason: "ścieżka nie istnieje".into(),
    })?;
    if !canonical.is_dir() {
        return Err(AppError::InvalidPath {
            path: input.to_string(),
            reason: "to nie jest katalog".into(),
        });
    }
    let canonical_str = canonical.to_string_lossy().to_string();
    if let Some(existing) = repo::get_by_path(conn, &canonical_str)? {
        return Ok(existing);
    }
    if canonical_str != input {
        if let Some(existing) = repo::get_by_path(conn, input)? {
            return Ok(existing);
        }
    }
    let name = canonical
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_str.clone());
    let claude_dir = encode_project_path(&canonical);
    repo::insert(conn, &name, &canonical_str, &claude_dir, None)
}

#[tauri::command]
pub fn find_or_create_project(state: State<AppState>, path: String) -> AppResult<Project> {
    let c = state.db.get()?;
    find_or_create(&c, &path)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:rust -- creates_then_reuses_project rejects_missing_and_file`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the command**

In `src-tauri/src/lib.rs`, add to the `tauri::generate_handler![ ... ]` list, after `commands::projects::reorder_projects,`:

```rust
            commands::projects::find_or_create_project,
```

- [ ] **Step 6: Add the frontend wrapper**

In `src/lib/tauri.ts`, add after the `reorderProjects` line:

```typescript
  findOrCreateProject: (path: string) =>
    invoke<Project>('find_or_create_project', { path }),
```

- [ ] **Step 7: Verify build + lint**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/projects.rs src-tauri/src/lib.rs src/lib/tauri.ts
git commit -m "feat(desktop): add find_or_create_project command"
```

---

### Task 3: CLI open-input parser

**Files:**
- Create: `src-tauri/src/cli/mod.rs`
- Create: `src-tauri/src/cli/open_input.rs`
- Modify: `src-tauri/src/lib.rs` (declare `pub mod cli;`)
- Test: `src-tauri/src/cli/open_input.rs`

**Interfaces:**
- Produces: `pub fn parse_open_input(raw: &str, base_cwd: Option<&str>) -> Option<String>`
  - Returns an absolute path string for a plain path or for an `abeon-code://open?path=<enc>` URL; returns `None` for non-path input.

- [ ] **Step 1: Create the module root**

Create `src-tauri/src/cli/mod.rs`:

```rust
pub mod open_input;
pub mod installer;
```

(Note: `installer` is created in Task 4. To compile Task 3 alone, temporarily comment the `pub mod installer;` line, then restore it in Task 4. If executing tasks in order with a single build at Task 4, leave it.)

- [ ] **Step 2: Declare the module in lib.rs**

In `src-tauri/src/lib.rs`, add after `pub mod commands;`:

```rust
pub mod cli;
```

- [ ] **Step 3: Write the failing test**

Create `src-tauri/src/cli/open_input.rs` with only the tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_path_passthrough() {
        assert_eq!(parse_open_input("/home/u/proj", None).as_deref(), Some("/home/u/proj"));
    }

    #[test]
    fn relative_path_joins_cwd() {
        assert_eq!(
            parse_open_input("proj", Some("/work")).as_deref(),
            Some("/work/proj"),
        );
    }

    #[test]
    fn dot_joins_cwd() {
        assert_eq!(parse_open_input(".", Some("/work")).as_deref(), Some("/work"));
    }

    #[test]
    fn deep_link_decodes_path() {
        assert_eq!(
            parse_open_input("abeon-code://open?path=%2Fhome%2Fu%2Fmy%20proj", None).as_deref(),
            Some("/home/u/my proj"),
        );
    }

    #[test]
    fn non_path_is_ignored() {
        assert_eq!(parse_open_input("-psn_0_123", None), None);
        assert_eq!(parse_open_input("--flag", None), None);
    }
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test:rust -- open_input`
Expected: FAIL — `cannot find function parse_open_input`.

- [ ] **Step 5: Write minimal implementation**

Prepend the implementation above the test module in `src-tauri/src/cli/open_input.rs`:

```rust
use std::path::Path;

const SCHEME: &str = "abeon-code://";

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn deep_link_path(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix(SCHEME)?;
    let query = rest.split_once('?').map(|(_, q)| q).unwrap_or("");
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == "path" {
                let decoded = percent_decode(v);
                if decoded.is_empty() {
                    return None;
                }
                return Some(decoded);
            }
        }
    }
    None
}

fn looks_like_path(raw: &str) -> bool {
    raw == "."
        || raw == ".."
        || raw.starts_with('/')
        || raw.starts_with("./")
        || raw.starts_with("../")
        || raw.starts_with('~')
        || (!raw.starts_with('-') && raw.contains('/'))
}

fn expand_tilde(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    raw.to_string()
}

pub fn parse_open_input(raw: &str, base_cwd: Option<&str>) -> Option<String> {
    let candidate = if raw.starts_with(SCHEME) {
        deep_link_path(raw)?
    } else if looks_like_path(raw) {
        expand_tilde(raw)
    } else {
        return None;
    };

    let p = Path::new(&candidate);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else if let Some(cwd) = base_cwd {
        Path::new(cwd).join(p)
    } else {
        p.to_path_buf()
    };
    Some(abs.to_string_lossy().to_string())
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:rust -- open_input`
Expected: PASS (5 tests). Note: `dot_joins_cwd` relies on `Path::new("/work").join(".")` normalizing — if it yields `/work/.`, change the assertion to `Some("/work/.")` and rely on `canonicalize` in `find_or_create` to normalize at use time. Verify actual output and keep the assertion matching it.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/cli/mod.rs src-tauri/src/cli/open_input.rs src-tauri/src/lib.rs
git commit -m "feat(desktop): add CLI open-input parser"
```

---

### Task 4: Installer + CLI commands + AppState buffer

**Files:**
- Create: `src-tauri/src/cli/installer.rs`
- Create: `src-tauri/src/commands/cli.rs`
- Modify: `src-tauri/src/commands/mod.rs` (declare module)
- Modify: `src-tauri/src/state.rs` (buffer fields)
- Modify: `src-tauri/src/lib.rs` (register commands)
- Modify: `src/lib/tauri.ts` (wrappers)
- Test: `src-tauri/src/cli/installer.rs`

**Interfaces:**
- Produces:
  - `pub fn wrapper_script(exe_path: &str) -> String`
  - `pub fn install(exe_path: &str, target_dir: &Path) -> AppResult<PathBuf>`
  - `#[tauri::command] pub fn install_cli_command() -> AppResult<String>`
  - `#[tauri::command] pub fn take_pending_open_paths(state) -> Vec<String>`
  - `AppState.pending_open_paths: Mutex<Vec<String>>`
  - `AppState.cli_frontend_ready: Mutex<bool>`
  - `tauri.installCliCommand(): Promise<string>`
  - `tauri.takePendingOpenPaths(): Promise<string[]>`

- [ ] **Step 1: Write the failing installer test**

Create `src-tauri/src/cli/installer.rs` with tests first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn script_contains_shebang_and_exe() {
        let s = wrapper_script("/opt/AbeonCode/abeoncode");
        assert!(s.starts_with("#!/usr/bin/env bash"));
        assert!(s.contains("/opt/AbeonCode/abeoncode"));
    }

    #[test]
    fn install_writes_executable_file() {
        let dir = tempdir().unwrap();
        let dest = install("/opt/AbeonCode/abeoncode", dir.path()).unwrap();
        assert_eq!(dest.file_name().unwrap().to_string_lossy(), "abeon-code");
        assert!(dest.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rust -- installer`
Expected: FAIL — `cannot find function wrapper_script`.

- [ ] **Step 3: Write minimal installer implementation**

Prepend to `src-tauri/src/cli/installer.rs`:

```rust
use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};

pub fn wrapper_script(exe_path: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
target="${{1:-.}}"
if [ -d "$target" ]; then
  abs="$(cd "$target" && pwd)"
else
  abs="$(cd "$(dirname -- "$target")" 2>/dev/null && pwd)/$(basename -- "$target")"
fi
exec "{exe_path}" "$abs"
"#
    )
}

pub fn install(exe_path: &str, target_dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(target_dir).map_err(|e| AppError::Other(e.to_string()))?;
    let dest = target_dir.join("abeon-code");
    std::fs::write(&dest, wrapper_script(exe_path)).map_err(|e| AppError::Other(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(dest)
}
```

- [ ] **Step 4: Run installer test to verify it passes**

Run: `npm run test:rust -- installer`
Expected: PASS (2 tests).

- [ ] **Step 5: Add AppState buffer fields**

In `src-tauri/src/state.rs`, add two fields to `pub struct AppState` (after `detected_models`):

```rust
    pub pending_open_paths: Mutex<Vec<String>>,
    pub cli_frontend_ready: Mutex<bool>,
```

And in `impl AppState::new`, after `detected_models: Mutex::new(None),`:

```rust
            pending_open_paths: Mutex::new(Vec::new()),
            cli_frontend_ready: Mutex::new(false),
```

- [ ] **Step 6: Create the CLI commands module**

Create `src-tauri/src/commands/cli.rs`:

```rust
use tauri::State;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::cli::installer;

#[tauri::command]
pub fn take_pending_open_paths(state: State<AppState>) -> Vec<String> {
    *state.cli_frontend_ready.lock() = true;
    std::mem::take(&mut *state.pending_open_paths.lock())
}

#[tauri::command]
pub fn install_cli_command() -> AppResult<String> {
    let exe = std::env::current_exe().map_err(|e| AppError::Other(format!("current_exe: {e}")))?;
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home dir".into()))?;
    let target = home.join(".local").join("bin");
    let dest = installer::install(&exe.to_string_lossy(), &target)?;
    Ok(dest.to_string_lossy().to_string())
}
```

- [ ] **Step 7: Declare the commands module**

In `src-tauri/src/commands/mod.rs`, add (alongside the other `pub mod` lines):

```rust
pub mod cli;
```

- [ ] **Step 8: Register the commands**

In `src-tauri/src/lib.rs`, add to `generate_handler![ ... ]` after the `find_or_create_project` line from Task 2:

```rust
            commands::cli::take_pending_open_paths,
            commands::cli::install_cli_command,
```

- [ ] **Step 9: Add frontend wrappers**

In `src/lib/tauri.ts`, add after the `findOrCreateProject` wrapper from Task 2:

```typescript
  takePendingOpenPaths: () => invoke<string[]>('take_pending_open_paths'),
  installCliCommand: () => invoke<string>('install_cli_command'),
  onCliOpenPath: (cb: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>('cli://open-path', e => cb(e.payload)),
```

- [ ] **Step 10: Verify build + lint**

Run: `npm run test:rust -- installer && npm run lint`
Expected: installer tests PASS; lint zero errors.

- [ ] **Step 11: Commit**

```bash
git add src-tauri/src/cli/installer.rs src-tauri/src/commands/cli.rs \
  src-tauri/src/commands/mod.rs src-tauri/src/state.rs src-tauri/src/lib.rs src/lib/tauri.ts
git commit -m "feat(desktop): add CLI install command and pending-path buffer"
```

---

### Task 5: Plugin registration + setup wiring

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/cli/mod.rs` (runtime glue)
- Modify: `src-tauri/src/lib.rs` (register plugins + setup)

**Interfaces:**
- Consumes: `parse_open_input` (Task 3), `AppState` buffer fields (Task 4).
- Produces:
  - `pub fn dispatch_open(app: &tauri::AppHandle, path: String)`
  - `pub fn scan_args_into_pending(app: &tauri::AppHandle, args: &[String], cwd: Option<&str>)`

- [ ] **Step 1: Add plugin dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add after `tauri-plugin-process = "2"`:

```toml
tauri-plugin-single-instance = "2"
tauri-plugin-deep-link = "2"
```

- [ ] **Step 2: Configure the deep-link scheme**

In `src-tauri/tauri.conf.json`, inside the `"plugins"` object, add a sibling to `"updater"`:

```json
    "deep-link": {
      "desktop": {
        "schemes": ["abeon-code"]
      }
    }
```

- [ ] **Step 3: Add the deep-link permission**

In `src-tauri/capabilities/default.json`, add to the `"permissions"` array (after `"process:default"`):

```json
    "deep-link:default"
```

- [ ] **Step 4: Add runtime glue to `cli/mod.rs`**

Append to `src-tauri/src/cli/mod.rs`:

```rust
use tauri::{AppHandle, Emitter, Manager};
use crate::state::AppState;

pub fn dispatch_open(app: &AppHandle, path: String) {
    let state = app.state::<AppState>();
    let ready = *state.cli_frontend_ready.lock();
    if ready {
        let _ = app.emit("cli://open-path", path);
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    } else {
        state.pending_open_paths.lock().push(path);
    }
}

pub fn scan_args_into_pending(app: &AppHandle, args: &[String], cwd: Option<&str>) {
    for raw in args.iter().skip(1) {
        if let Some(path) = open_input::parse_open_input(raw, cwd) {
            dispatch_open(app, path);
        }
    }
}
```

- [ ] **Step 5: Register the single-instance plugin (must be first)**

In `src-tauri/src/lib.rs`, change the builder chain so single-instance is the **first** plugin. Replace:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
```

with:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            crate::cli::scan_args_into_pending(app, &argv, Some(&cwd));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
```

- [ ] **Step 6: Wire deep-link + cold-start argv in `setup`**

In `src-tauri/src/lib.rs`, inside the existing `.setup(|app| { ... })` closure, add **before** `Ok(())`:

```rust
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(path) = crate::cli::open_input::parse_open_input(url.as_str(), None) {
                            crate::cli::dispatch_open(&handle, path);
                        }
                    }
                });
            }
            let cwd = std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string());
            let args: Vec<String> = std::env::args().collect();
            crate::cli::scan_args_into_pending(app.handle(), &args, cwd.as_deref());
```

- [ ] **Step 7: Build the backend**

Run: `npm run test:rust`
Expected: compiles; all existing + new tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json \
  src-tauri/capabilities/default.json src-tauri/src/cli/mod.rs src-tauri/src/lib.rs
git commit -m "feat(desktop): register single-instance and deep-link plugins for CLI launch"
```

---

### Task 6: Frontend open handler + boot drain + listener

**Files:**
- Create: `src/lib/openProject.ts`
- Create: `src/lib/openProject.test.ts`
- Modify: `src/store/index.ts` (boot drain)
- Modify: `src/components/layout/AppShell.tsx` (listener)

**Interfaces:**
- Consumes: `tauri.findOrCreateProject`, `tauri.takePendingOpenPaths`, `tauri.onCliOpenPath` (Tasks 2, 4); store `loadProjects`, `openNewSessionTab`.
- Produces: `export async function openProjectPath(path: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/openProject.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../types';

const findOrCreateProject = vi.fn();
const listProjects = vi.fn();

vi.mock('./tauri', () => ({
  tauri: {
    findOrCreateProject: (p: string) => findOrCreateProject(p),
    listProjects: () => listProjects(),
  },
}));

import { openProjectPath } from './openProject';
import { useStore } from '../store';

const project: Project = {
  id: 42, name: 'demo', path: '/x/demo', claudeDir: '-x-demo',
  color: null, sortOrder: 0, createdAt: 0,
};

describe('openProjectPath', () => {
  beforeEach(() => {
    findOrCreateProject.mockReset().mockResolvedValue(project);
    listProjects.mockReset().mockResolvedValue([project]);
    useStore.setState({ tabs: [], activeTabId: null, enabledProviders: ['claude'] });
  });

  it('resolves the project then opens a new session tab', async () => {
    await openProjectPath('/x/demo');
    expect(findOrCreateProject).toHaveBeenCalledWith('/x/demo');
    expect(listProjects).toHaveBeenCalled();
    const tabs = useStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].projectId).toBe(42);
  });

  it('swallows errors from the command', async () => {
    findOrCreateProject.mockRejectedValue(new Error('bad path'));
    await expect(openProjectPath('/nope')).resolves.toBeUndefined();
    expect(useStore.getState().tabs.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- openProject`
Expected: FAIL — cannot resolve `./openProject`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/openProject.ts`:

```typescript
import { tauri } from './tauri';
import { useStore } from '../store';

export async function openProjectPath(path: string): Promise<void> {
  try {
    const project = await tauri.findOrCreateProject(path);
    await useStore.getState().loadProjects();
    useStore.getState().openNewSessionTab(project.id);
  } catch (err) {
    console.error('[cli] openProjectPath failed', path, err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- openProject`
Expected: PASS (2 tests).

- [ ] **Step 5: Drain pending paths on boot**

In `src/store/index.ts`, add a drain function above the final `if (!windowMode)` block:

```typescript
async function drainPendingOpenPaths(): Promise<void> {
  try {
    const paths = await tauri.takePendingOpenPaths();
    const { openProjectPath } = await import('../lib/openProject');
    for (const p of paths) await openProjectPath(p);
  } catch (err) {
    console.error('[cli] drainPendingOpenPaths failed', err);
  }
}
```

Then change the final block from:

```typescript
if (!windowMode) {
  void bootstrapShellPath();
}
```

to:

```typescript
if (!windowMode) {
  void bootstrapShellPath().then(() => drainPendingOpenPaths());
}
```

- [ ] **Step 6: Register the runtime listener in AppShell**

In `src/components/layout/AppShell.tsx`, add this `useEffect` after the existing attention-listener effect (the one ending at line ~150). Add the import at the top: `import { openProjectPath } from '../../lib/openProject';`

```tsx
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    tauri.onCliOpenPath((path) => { void openProjectPath(path); })
      .then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);
```

- [ ] **Step 7: Verify tests + lint**

Run: `npm test -- openProject && npm run lint`
Expected: tests PASS; lint zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/openProject.ts src/lib/openProject.test.ts \
  src/store/index.ts src/components/layout/AppShell.tsx
git commit -m "feat(desktop): handle CLI open-path on boot and at runtime"
```

---

### Task 7: Settings — install CLI button

**Files:**
- Modify: `src/components/dialogs/SettingsDialog.tsx`

**Interfaces:**
- Consumes: `tauri.installCliCommand` (Task 4).

- [ ] **Step 1: Add the section component**

In `src/components/dialogs/SettingsDialog.tsx`, add a new component just above `function CliTab()` (around line 304):

```tsx
function CliCommandSection() {
  const [installedPath, setInstalledPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doInstall = () => {
    setError(null);
    tauri.installCliCommand()
      .then(setInstalledPath)
      .catch(err => setError(String(err?.message ?? err)));
  };

  return (
    <div className="space-y-2">
      <h3 className="text-[12px] font-semibold text-fg">Komenda terminala</h3>
      <p className="text-[11px] text-muted">
        Instaluje komendę <code className="mx-1">abeon-code</code> w
        <code className="mx-1">~/.local/bin</code>. Użyj
        <code className="mx-1">abeon-code .</code>, aby otworzyć projekt i nową sesję
        z konsoli. Upewnij się, że ten katalog jest w <code>PATH</code>.
      </p>
      <button onClick={doInstall} className="text-accent underline text-[12px]">
        Zainstaluj komendę
      </button>
      {installedPath && (
        <p className="text-[11px] text-success">Zainstalowano: {installedPath}</p>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Render it inside `CliTab`**

Change `CliTab` to include the new section:

```tsx
function CliTab() {
  return (
    <div className="space-y-6">
      <ProvidersSection />
      <TitleGenSection />
      <CliCommandSection />
    </div>
  );
}
```

- [ ] **Step 3: Verify lint**

Run: `npm run lint`
Expected: zero errors. (`useState`, `tauri` are already imported in this file.)

- [ ] **Step 4: Commit**

```bash
git add src/components/dialogs/SettingsDialog.tsx
git commit -m "feat(desktop): add install CLI command button in settings"
```

---

### Task 8: Manual test documentation

**Files:**
- Create: `docs/abeon-code-cli.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write the manual verification doc**

Create `docs/abeon-code-cli.md`:

```markdown
# Komenda `abeon-code`

Otwiera aplikację AbeonCode i uruchamia nową sesję w projekcie dla wskazanego
katalogu (tworząc projekt, jeśli nie istnieje).

## Instalacja

Ustawienia → CLI → „Zainstaluj komendę". Zapisuje wrapper do `~/.local/bin/abeon-code`.
Upewnij się, że `~/.local/bin` jest w `PATH`.

## Użycie

    abeon-code            # bieżący katalog
    abeon-code .          # bieżący katalog
    abeon-code ~/proj     # wskazany katalog

Plik jako argument → błąd (akceptowane są tylko katalogi).

## Weryfikacja manualna

1. **Zimny start (CLI):** aplikacja zamknięta → `abeon-code /ścieżka/do/projektu`
   → aplikacja startuje, projekt zaznaczony, otwarta nowa sesja.
2. **Ciepły start (CLI):** aplikacja otwarta → `abeon-code /inny/projekt`
   → okno wraca na wierzch, nowa sesja w drugim projekcie.
3. **Nowy projekt:** wskaż katalog bez projektu → projekt tworzony z nazwą = basename.
4. **Deep-link (ciepły):** `xdg-open 'abeon-code://open?path=/ścieżka'` (Linux) lub
   `open 'abeon-code://open?path=/ścieżka'` (macOS) → nowa sesja.
5. **Błąd:** `abeon-code /nie/istnieje` → aplikacja zgłasza błąd, nie tworzy projektu.
```

- [ ] **Step 2: Commit**

```bash
git add docs/abeon-code-cli.md
git commit -m "docs: document abeon-code CLI command"
```

---

## Self-Review

**Spec coverage:**
- CLI entry (single-instance + argv) → Tasks 3, 5.
- Deep-link entry → Task 5 (`on_open_url`, scheme config, parser in Task 3).
- `find_or_create_project` + `get_by_path` → Tasks 1, 2.
- Pending buffer + boot pull → Tasks 4, 6.
- Warm-start event `cli://open-path` → Tasks 4 (wrapper), 5 (emit), 6 (listener).
- Always new session → Task 6 (`openNewSessionTab`).
- Name = basename, file→error, missing→error, canonicalization → Task 2.
- No-arg → `.` → Task 4 wrapper script.
- Install CLI via Settings (VS Code style) → Tasks 4 (command), 7 (UI).
- Linux + macOS wrapper via `current_exe()` → Task 4.
- Tests (Rust unit, Vitest, manual) → Tasks 1–6, 8.

**Type consistency:** `find_or_create_project`/`findOrCreateProject`, `take_pending_open_paths`/`takePendingOpenPaths`, `install_cli_command`/`installCliCommand`, event `cli://open-path`, `dispatch_open`, `scan_args_into_pending`, `parse_open_input`, `wrapper_script`, `install`, `get_by_path`, `openProjectPath` — names match across tasks.

**Notes / risks:**
- `dot_joins_cwd` test (Task 3) may need its assertion adjusted to the actual `Path::join` output (`/work/.`); `canonicalize` normalizes it at use time. Verify and match.
- Existing UI-added projects store a possibly non-canonical path; `find_or_create` checks both canonical and raw input to avoid accidental duplicates. A symlinked path added via the UI could still create a second project for the same physical dir — acceptable for v1.
- Capability `deep-link:default` enables only `get_current`; harmless even though routing is handled in Rust.
