# Clipboard Image Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Intercept image paste in claude-type xterm terminals, save image to a temp file via the Rust backend, and write the file path into the PTY so Claude CLI can process it.

**Architecture:** DOM `paste` event listener with `capture: true` on the xterm container intercepts image clipboard data before xterm processes it. Image bytes are sent as base64 to a new Rust command that writes them to `temp_dir()/abeoncode-images/{uuid}.png`. The returned path is written into the PTY. Temp files are tracked per PTY ID and cleaned up when the PTY is killed.

**Tech Stack:** Rust (Tauri 2, base64, uuid, std::fs), TypeScript (React, xterm.js, Tauri IPC)

---

### Task 1: Add `clipboard_images` tracking to `AppState`

**Files:**
- Modify: `src-tauri/src/state.rs:1-24`

- [ ] **Step 1: Write the test**

Add a `#[cfg(test)]` module at the bottom of `src-tauri/src/state.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_state() -> AppState {
        let pool = crate::db::init_pool(":memory:").expect("in-memory db");
        AppState::new(pool)
    }

    #[test]
    fn clipboard_images_insert_and_remove() {
        let state = test_state();
        let pty_id = "test-pty-1".to_string();
        let path = PathBuf::from("/tmp/test.png");

        {
            let mut map = state.clipboard_images.lock();
            map.entry(pty_id.clone()).or_default().push(path.clone());
        }

        {
            let map = state.clipboard_images.lock();
            let paths = map.get(&pty_id).unwrap();
            assert_eq!(paths.len(), 1);
            assert_eq!(paths[0], path);
        }

        {
            let mut map = state.clipboard_images.lock();
            let removed = map.remove(&pty_id);
            assert!(removed.is_some());
            assert!(map.get(&pty_id).is_none());
        }
    }
}
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `cd src-tauri && cargo test state::tests::clipboard_images_insert_and_remove -- --nocapture`

Expected: compile error — `clipboard_images` field does not exist on `AppState`.

- [ ] **Step 3: Add the field and initialize it**

In `src-tauri/src/state.rs`, add `use std::path::PathBuf;` to the imports, add the new field to `AppState`, and initialize it in `new()`:

```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::Mutex;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;
use crate::pty::PtyManager;

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
    pub pty: Arc<PtyManager>,
    pub shell_env: Mutex<Option<HashMap<String, String>>>,
    pub clipboard_images: Mutex<HashMap<String, Vec<PathBuf>>>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            session_watchers: SessionWatchers::new(),
            pty: PtyManager::new(),
            shell_env: Mutex::new(None),
            clipboard_images: Mutex::new(HashMap::new()),
        }
    }
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd src-tauri && cargo test state::tests::clipboard_images_insert_and_remove -- --nocapture`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(clipboard): add clipboard_images tracking to AppState"
```

---

### Task 2: Add `save_clipboard_image` Rust command

**Files:**
- Modify: `src-tauri/src/commands/pty.rs:1-97`

- [ ] **Step 1: Write the test**

Add a `#[cfg(test)]` module at the bottom of `src-tauri/src/commands/pty.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn save_clipboard_image_creates_file() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(":memory:").expect("in-memory db"),
        );
        let pty_id = "test-pty-img".to_string();

        // 1x1 red PNG as base64
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

        let result = save_clipboard_image_inner(&state, pty_id.clone(), png_b64.to_string());
        assert!(result.is_ok(), "save failed: {:?}", result.err());

        let path_str = result.unwrap();
        let path = Path::new(&path_str);
        assert!(path.exists(), "file should exist at {path_str}");
        assert!(path_str.contains("abeoncode-images"));
        assert!(path_str.ends_with(".png"));

        // Verify tracked in state
        let map = state.clipboard_images.lock();
        let tracked = map.get(&pty_id).unwrap();
        assert_eq!(tracked.len(), 1);
        assert_eq!(tracked[0].to_string_lossy(), path_str);

        // Cleanup
        drop(map);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_clipboard_image_invalid_base64() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(":memory:").expect("in-memory db"),
        );
        let result = save_clipboard_image_inner(&state, "pty".into(), "not-valid-b64!!!".into());
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `cd src-tauri && cargo test commands::pty::tests -- --nocapture`

Expected: compile error — `save_clipboard_image_inner` does not exist.

- [ ] **Step 3: Implement `save_clipboard_image_inner` and the Tauri command**

Add these imports to the top of `src-tauri/src/commands/pty.rs` (merge with existing):

```rust
use std::path::PathBuf;
use uuid::Uuid;
```

Add these two functions after the existing `pty_kill` command:

```rust
fn save_clipboard_image_inner(
    state: &AppState,
    pty_id: String,
    data: String,
) -> AppResult<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| AppError::Other(format!("base64: {e}")))?;

    let dir = std::env::temp_dir().join("abeoncode-images");
    std::fs::create_dir_all(&dir)?;

    let filename = format!("{}.png", Uuid::new_v4());
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes)?;

    let path_str = path.to_string_lossy().to_string();
    state
        .clipboard_images
        .lock()
        .entry(pty_id)
        .or_default()
        .push(path.clone());

    Ok(path_str)
}

#[tauri::command]
pub fn save_clipboard_image(
    state: State<AppState>,
    pty_id: String,
    data: String,
) -> AppResult<String> {
    save_clipboard_image_inner(&state, pty_id, data)
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd src-tauri && cargo test commands::pty::tests -- --nocapture`

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pty.rs
git commit -m "feat(clipboard): add save_clipboard_image command"
```

---

### Task 3: Add cleanup of temp images in `pty_kill`

**Files:**
- Modify: `src-tauri/src/commands/pty.rs` (the `pty_kill` function and tests)

- [ ] **Step 1: Write the test**

Add to the existing `#[cfg(test)] mod tests` block in `src-tauri/src/commands/pty.rs`:

```rust
    #[test]
    fn cleanup_removes_tracked_files() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(":memory:").expect("in-memory db"),
        );
        let pty_id = "cleanup-test".to_string();

        let dir = std::env::temp_dir().join("abeoncode-images");
        std::fs::create_dir_all(&dir).unwrap();
        let file1 = dir.join("cleanup1.png");
        let file2 = dir.join("cleanup2.png");
        std::fs::write(&file1, b"fake1").unwrap();
        std::fs::write(&file2, b"fake2").unwrap();

        {
            let mut map = state.clipboard_images.lock();
            map.insert(pty_id.clone(), vec![file1.clone(), file2.clone()]);
        }

        cleanup_clipboard_images(&state, &pty_id);

        assert!(!file1.exists(), "file1 should be deleted");
        assert!(!file2.exists(), "file2 should be deleted");
        assert!(state.clipboard_images.lock().get(&pty_id).is_none());
    }
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `cd src-tauri && cargo test commands::pty::tests::cleanup_removes_tracked_files -- --nocapture`

Expected: compile error — `cleanup_clipboard_images` does not exist.

- [ ] **Step 3: Implement `cleanup_clipboard_images` and wire into `pty_kill`**

Add this function before the `pty_kill` command in `src-tauri/src/commands/pty.rs`:

```rust
fn cleanup_clipboard_images(state: &AppState, pty_id: &str) {
    if let Some(paths) = state.clipboard_images.lock().remove(pty_id) {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }
}
```

Update `pty_kill` to call it:

```rust
#[tauri::command]
pub fn pty_kill(state: State<AppState>, pty_id: String) -> AppResult<()> {
    cleanup_clipboard_images(&state, &pty_id);
    state.pty.kill(&pty_id)
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd src-tauri && cargo test commands::pty::tests -- --nocapture`

Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pty.rs
git commit -m "feat(clipboard): cleanup temp images on pty_kill"
```

---

### Task 4: Register command in Tauri and add IPC wrapper

**Files:**
- Modify: `src-tauri/src/lib.rs:30-64` (add to `generate_handler!`)
- Modify: `src/lib/tauri.ts` (add wrapper function)

- [ ] **Step 1: Register the Rust command**

In `src-tauri/src/lib.rs`, add `commands::pty::save_clipboard_image` to the `generate_handler![]` macro, after the existing `commands::pty::pty_kill` line:

```rust
            commands::pty::pty_kill,
            commands::pty::save_clipboard_image,
```

- [ ] **Step 2: Add the TypeScript wrapper**

In `src/lib/tauri.ts`, add after the `ptyKill` line:

```typescript
  saveClipboardImage: (ptyId: string, data: string) =>
    invoke<string>('save_clipboard_image', { ptyId, data }),
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cd src-tauri && cargo check`

Expected: no errors.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npm run lint`

Expected: only the 2 pre-existing baseline errors, no new ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/lib/tauri.ts
git commit -m "feat(clipboard): register save_clipboard_image command and IPC wrapper"
```

---

### Task 5: Add paste event listener in `TerminalView`

**Files:**
- Modify: `src/components/terminal/TerminalView.tsx`

- [ ] **Step 1: Add the paste handler inside the main `useEffect`**

In `src/components/terminal/TerminalView.tsx`, inside the `tauri.spawnPty(...).then(async (id) => { ... })` callback, after the `term.onResize(...)` block (line ~116) and before the closing `});` of the `.then()`, add the paste listener:

```typescript
      if (kind === 'claude') {
        const onPaste = async (e: ClipboardEvent) => {
          const items = e.clipboardData?.items;
          if (!items) return;

          let imageItem: DataTransferItem | null = null;
          for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
              imageItem = items[i];
              break;
            }
          }
          if (!imageItem) return;

          e.preventDefault();
          e.stopPropagation();

          const blob = imageItem.getAsFile();
          if (!blob) return;

          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const b64 = btoa(binary);

          try {
            const filePath = await tauri.saveClipboardImage(id, b64);
            const encoded = btoa(unescape(encodeURIComponent(filePath)));
            await tauri.ptyWrite(id, encoded);
          } catch {
            // IPC or fs error — silently skip, user can retry
          }
        };

        container.addEventListener('paste', onPaste as EventListener, { capture: true });
        unlistenRefs.current.push(() =>
          container.removeEventListener('paste', onPaste as EventListener, { capture: true })
        );
      }
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npm run lint`

Expected: only the 2 pre-existing baseline errors, no new ones.

- [ ] **Step 3: Manual verification**

Run the full app with `npm run tauri dev`. Open a claude session tab. Copy an image to clipboard (e.g. screenshot). Paste with Ctrl+V in the claude terminal.

Verify:
1. A file path like `/tmp/abeoncode-images/{uuid}.png` appears in the terminal input
2. The file exists on disk at that path
3. Normal text paste (Ctrl+V with text in clipboard) still works as before
4. Paste in shell and action terminals is unaffected

- [ ] **Step 4: Commit**

```bash
git add src/components/terminal/TerminalView.tsx
git commit -m "feat(clipboard): intercept image paste in claude terminal"
```

---

### Task 6: Integration test — full Rust backend flow

**Files:**
- Modify: `src-tauri/src/commands/pty.rs` (add one more test to the existing test module)

- [ ] **Step 1: Write the integration test**

Add to `#[cfg(test)] mod tests` in `src-tauri/src/commands/pty.rs`:

```rust
    #[test]
    fn full_flow_save_then_cleanup() {
        let state = crate::state::AppState::new(
            crate::db::init_pool(":memory:").expect("in-memory db"),
        );
        let pty_id = "flow-test".to_string();

        // 1x1 red PNG
        let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

        // Save two images
        let path1 = save_clipboard_image_inner(&state, pty_id.clone(), png_b64.to_string()).unwrap();
        let path2 = save_clipboard_image_inner(&state, pty_id.clone(), png_b64.to_string()).unwrap();
        assert_ne!(path1, path2, "UUIDs should differ");
        assert!(Path::new(&path1).exists());
        assert!(Path::new(&path2).exists());

        // Verify both tracked
        assert_eq!(state.clipboard_images.lock().get(&pty_id).unwrap().len(), 2);

        // Cleanup
        cleanup_clipboard_images(&state, &pty_id);
        assert!(!Path::new(&path1).exists());
        assert!(!Path::new(&path2).exists());
        assert!(state.clipboard_images.lock().get(&pty_id).is_none());
    }
```

- [ ] **Step 2: Run all pty tests — expect PASS**

Run: `cd src-tauri && cargo test commands::pty::tests -- --nocapture`

Expected: all 4 tests PASS.

- [ ] **Step 3: Run full test suites**

Run: `cd src-tauri && cargo test` and `npm test`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/pty.rs
git commit -m "test(clipboard): add full-flow save+cleanup integration test"
```
