# Clipboard Image Paste in Terminal

## Summary

Intercept image paste events in claude-type terminals, save the image to a temp file via Tauri backend, and paste the file path into the PTY. This lets Claude CLI process images pasted from the clipboard without the user manually saving files.

## Scope

- **Terminal types**: claude only (not action, not shell)
- **Temp cleanup**: files deleted when the tab/session is closed (pty_kill)
- **UX feedback**: path only — no toast, no visual indicator
- **New dependencies**: none

## Data Flow

```
User Ctrl+V (image in clipboard)
    │
    ▼
DOM 'paste' event (capture:true on xterm container)
    │
    ├─ clipboardData contains image/* ?
    │   ├─ YES → preventDefault(), read blob
    │   │         │
    │   │         ▼
    │   │   blob → arrayBuffer → base64 string
    │   │         │
    │   │         ▼
    │   │   invoke('save_clipboard_image', { ptyId, data: base64 })
    │   │         │
    │   │         ▼  (Rust)
    │   │   decode base64 → write to temp_dir()/abeoncode-images/{uuid}.png
    │   │   register path in AppState clipboard_images map
    │   │         │
    │   │         ▼
    │   │   return file path (String)
    │   │         │
    │   │         ▼  (JS)
    │   │   ptyWrite(ptyId, base64encode(path)) — typed into terminal
    │   │
    │   └─ NO → event passes through, xterm handles normal text paste
    │
    └─ kind !== 'claude' → no listener registered
```

## File Changes

### Backend

#### `src-tauri/src/state.rs`

New field on `AppState`:

```rust
pub clipboard_images: Mutex<HashMap<String, Vec<PathBuf>>>
```

Tracks temp image paths per PTY ID for cleanup. `Mutex` (not `RwLock`) because writes dominate (each paste + each kill) and critical sections are minimal.

Initialize as `Mutex::new(HashMap::new())` in `AppState::new()`.

#### `src-tauri/src/commands/pty.rs`

New command `save_clipboard_image`:

```rust
#[tauri::command]
pub fn save_clipboard_image(
    state: State<AppState>,
    pty_id: String,
    data: String,
) -> AppResult<String>
```

Logic:
1. Decode base64 `data` → `Vec<u8>`
2. Build path: `std::env::temp_dir() / "abeoncode-images" / "{uuid}.png"`
3. Create dir if needed (`std::fs::create_dir_all`)
4. Write bytes to file
5. Insert path into `state.clipboard_images` under `pty_id`
6. Return path as `String`

Extend `pty_kill`: after killing the PTY process, remove entry from `clipboard_images` map and delete all associated files (ignore deletion errors — files may already be gone).

#### `src-tauri/src/lib.rs`

Register `commands::pty::save_clipboard_image` in `generate_handler![]`.

### Frontend

#### `src/lib/tauri.ts`

New wrapper:

```typescript
saveClipboardImage: (ptyId: string, data: string) =>
    invoke<string>('save_clipboard_image', { ptyId, data }),
```

#### `src/components/terminal/TerminalView.tsx`

New `paste` event listener inside the main `useEffect`, added after PTY spawn resolves. Only registered when `kind === 'claude'`.

Handler:
1. Check `e.clipboardData?.items` for entries with `type.startsWith('image/')`
2. If image found: `preventDefault()`, `stopPropagation()`
3. Read as blob → arrayBuffer → base64
4. Call `tauri.saveClipboardImage(ptyId, base64)`
5. Encode returned path as base64 and write to PTY via `tauri.ptyWrite(ptyId, encodedPath)`
6. If no image: do nothing, let xterm handle normally

Guard: skip if `ptyRef.current` is null (PTY not yet spawned).

## Edge Cases

- **PTY not ready**: paste ignored if ptyRef.current is null
- **Mixed paste (text + image)**: image takes priority — only the path is pasted
- **Large images**: no size limit enforced — temp_dir has OS-level limits; if write fails, the error surfaces through IPC and paste is silently skipped
- **Cleanup on crash**: files in temp_dir survive app crash; OS cleans temp_dir eventually
- **webkit2gtk clipboard**: clipboardData.items should expose image blobs in webkit2gtk; needs runtime verification

## Out of Scope

- Drag-and-drop image support
- Image preview in terminal
- Multiple image paste in single event
- Support for action/shell terminal types
