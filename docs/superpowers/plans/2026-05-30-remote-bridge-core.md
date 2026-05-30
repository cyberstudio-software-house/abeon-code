# Remote Bridge Core (2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Rust-side contract types and the pure command-dispatch core for remote control of AI-CLI sessions — without any network code.

**Architecture:** A new `src-tauri/src/remote/` module holds the IPC-boundary contract (`RemoteCommand` / `RemoteEnvelope` / `RemoteEvent`), a `SessionPtyRegistry` mapping `sessionId → ptyId`, and a pure `command_to_action` function that turns a remote command plus registry state into a concrete `PtyAction` (write / kill / spawn / reject). Effectful execution and the real Centrifugo WebSocket client are deferred to plan 2b. The registry is populated in the existing `spawn_pty` and cleared in `pty_kill`.

**Tech Stack:** Rust, serde, ts-rs (v11), parking_lot, existing `PtyManager` / `PtyKind`. No new crates.

**Scope note:** This is sub-project #2a of the AbeonCloud remote bridge (see `docs/superpowers/specs/2026-05-30-abeoncloud-remote-bridge-design.md`). Plan 2b adds the event bus tap, the async run-loop, the real WebSocket client, and the `allowRemoteSpawn` setting wiring.

**Follow-up carried into 2b (from 2a code review):** The registry is unbound only in `pty_kill`. When a Claude process exits on its own, the `pty:{id}:exit` path (`src-tauri/src/pty/handle.rs`) must also call `state.session_pty.unbind_pty(&pty_id)` to avoid a stale `sessionId → ptyId` entry. Deferred to 2b deliberately: the exit signal is most cleanly consumed where the bridge already subscribes to exit events, and `PtyHandle`'s exit thread has only an `AppHandle`, not `AppState`. The leak is non-harmful in 2a (writes/kills to a dead pty id are handled gracefully and a rebind overwrites the entry).

---

## File Structure

- Create `src-tauri/src/remote/mod.rs` — module exports.
- Create `src-tauri/src/remote/protocol.rs` — contract types with ts-rs derives.
- Create `src-tauri/src/remote/registry.rs` — `SessionPtyRegistry`.
- Create `src-tauri/src/remote/dispatch.rs` — `PtyAction` + pure `command_to_action` + `session_to_bind`.
- Modify `src-tauri/src/lib.rs:8` — register `pub mod remote;`.
- Modify `src-tauri/src/state.rs:9-32` — add `session_pty: Arc<SessionPtyRegistry>` to `AppState`.
- Modify `src-tauri/src/commands/pty.rs:118-122` — bind session→pty after spawn.
- Modify `src-tauri/src/commands/pty.rs:145-149` — unbind on kill.
- Generated: `src/types/RemoteCommand.ts`, `RemoteEnvelope.ts`, `RemoteEvent.ts` (ts-rs emits during `cargo test`).

---

### Task 1: Module scaffold

**Files:**
- Create: `src-tauri/src/remote/mod.rs`
- Modify: `src-tauri/src/lib.rs:8`

- [ ] **Step 1: Create the module file**

Create `src-tauri/src/remote/mod.rs`:

```rust
pub mod protocol;
pub mod registry;
pub mod dispatch;
```

- [ ] **Step 2: Register the module in the crate root**

In `src-tauri/src/lib.rs`, after line 8 (`pub mod git;`), add:

```rust
pub mod remote;
```

- [ ] **Step 3: Create empty submodule files so the crate compiles**

Create `src-tauri/src/remote/protocol.rs`, `src-tauri/src/remote/registry.rs`, and `src-tauri/src/remote/dispatch.rs` each containing a single line:

```rust
// implemented in subsequent tasks
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds with no errors (warnings about empty modules are fine).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote/ src-tauri/src/lib.rs
git commit -m "feat(remote): scaffold remote bridge module"
```

---

### Task 2: Contract types (`protocol.rs`)

**Files:**
- Modify: `src-tauri/src/remote/protocol.rs`

The serde conventions mirror `PtyKind` (`src-tauri/src/commands/pty.rs:10-29`): camelCase variant tag, snake_case struct-variant fields, `#[ts(type = "number")]` for `i64`.

- [ ] **Step 1: Write the failing test**

Replace the contents of `src-tauri/src/remote/protocol.rs` with the test first (implementation added in Step 3):

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_prompt_round_trips_with_type_tag() {
        let cmd = RemoteCommand::SendPrompt {
            session_id: "s1".into(),
            text: "hello".into(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert_eq!(json, r#"{"type":"sendPrompt","sessionId":"s1","text":"hello"}"#);
        let back: RemoteCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cmd);
    }

    #[test]
    fn envelope_round_trips() {
        let env = RemoteEnvelope {
            command_id: "c1".into(),
            command: RemoteCommand::StopSession { session_id: "s1".into() },
        };
        let json = serde_json::to_string(&env).unwrap();
        let back: RemoteEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, env);
        assert!(json.contains(r#""commandId":"c1""#));
        assert!(json.contains(r#""type":"stopSession""#));
    }

    #[test]
    fn cmd_result_omits_error_when_none() {
        let ev = RemoteEvent::CmdResult { command_id: "c1".into(), ok: true, error: None };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"type":"cmdResult","commandId":"c1","ok":true}"#);
    }

    #[test]
    fn resume_session_carries_project_id() {
        let cmd = RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains(r#""type":"resumeSession""#));
        assert!(json.contains(r#""projectId":7"#));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::protocol`
Expected: FAIL — `cannot find type RemoteCommand in this scope`.

- [ ] **Step 3: Write the implementation**

Insert the type definitions at the top of `src-tauri/src/remote/protocol.rs`, directly after the `use` lines and before the `#[cfg(test)] mod tests`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RemoteCommand {
    SendPrompt { session_id: String, text: String },
    ApprovePermission { session_id: String },
    DenyPermission { session_id: String },
    StopSession { session_id: String },
    ResumeSession {
        session_id: String,
        #[ts(type = "number")]
        project_id: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct RemoteEnvelope {
    pub command_id: String,
    pub command: RemoteCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RemoteEvent {
    CmdResult {
        command_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::protocol`
Expected: PASS (4 tests).

- [ ] **Step 5: Materialize the generated TS types and verify lint**

ts-rs writes `src/types/*.ts` during `cargo test`, not `cargo build`. The previous step already ran `cargo test`, so the files now exist.

Run: `ls src/types/RemoteCommand.ts src/types/RemoteEnvelope.ts src/types/RemoteEvent.ts`
Expected: all three paths listed.

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/remote/protocol.rs src/types/RemoteCommand.ts src/types/RemoteEnvelope.ts src/types/RemoteEvent.ts
git commit -m "feat(remote): add remote command/event contract types"
```

---

### Task 3: Session→PTY registry (`registry.rs`)

**Files:**
- Modify: `src-tauri/src/remote/registry.rs`

- [ ] **Step 1: Write the failing test**

Replace the contents of `src-tauri/src/remote/registry.rs` with:

```rust
use std::collections::HashMap;
use parking_lot::Mutex;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_then_lookup() {
        let reg = SessionPtyRegistry::new();
        reg.bind("sess-1", "pty-a");
        assert_eq!(reg.pty_for("sess-1"), Some("pty-a".to_string()));
        assert_eq!(reg.pty_for("missing"), None);
    }

    #[test]
    fn rebind_overwrites() {
        let reg = SessionPtyRegistry::new();
        reg.bind("sess-1", "pty-a");
        reg.bind("sess-1", "pty-b");
        assert_eq!(reg.pty_for("sess-1"), Some("pty-b".to_string()));
    }

    #[test]
    fn unbind_pty_removes_all_entries_for_that_pty() {
        let reg = SessionPtyRegistry::new();
        reg.bind("sess-1", "pty-a");
        reg.bind("sess-2", "pty-b");
        reg.unbind_pty("pty-a");
        assert_eq!(reg.pty_for("sess-1"), None);
        assert_eq!(reg.pty_for("sess-2"), Some("pty-b".to_string()));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::registry`
Expected: FAIL — `cannot find type SessionPtyRegistry`.

- [ ] **Step 3: Write the implementation**

Insert above the `#[cfg(test)]` block in `src-tauri/src/remote/registry.rs`:

```rust
/// Maps a Claude `sessionId` to the live `ptyId` backing it, so remote
/// commands can be routed to the right PTY. Populated in `spawn_pty`,
/// cleared in `pty_kill`.
#[derive(Default)]
pub struct SessionPtyRegistry {
    inner: Mutex<HashMap<String, String>>,
}

impl SessionPtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bind(&self, session_id: &str, pty_id: &str) {
        self.inner.lock().insert(session_id.to_string(), pty_id.to_string());
    }

    pub fn pty_for(&self, session_id: &str) -> Option<String> {
        self.inner.lock().get(session_id).cloned()
    }

    pub fn unbind_pty(&self, pty_id: &str) {
        self.inner.lock().retain(|_, v| v != pty_id);
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::registry`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote/registry.rs
git commit -m "feat(remote): add session-to-pty registry"
```

---

### Task 4: Pure command dispatch (`dispatch.rs`) — USER CONTRIBUTION POINT

**Files:**
- Modify: `src-tauri/src/remote/dispatch.rs`

This task contains the one piece with real domain decisions: what bytes does "approve" send to the Claude TUI, what does "deny" send, and what happens on an unknown session or when remote spawn is disabled. During execution, pause here and let the user write `command_to_action` before revealing the reference implementation below.

- [ ] **Step 1: Write the failing test**

Replace the contents of `src-tauri/src/remote/dispatch.rs` with:

```rust
use crate::commands::pty::PtyKind;
use crate::remote::protocol::RemoteCommand;
use crate::remote::registry::SessionPtyRegistry;

#[cfg(test)]
mod tests {
    use super::*;

    fn reg_with(session: &str, pty: &str) -> SessionPtyRegistry {
        let r = SessionPtyRegistry::new();
        r.bind(session, pty);
        r
    }

    #[test]
    fn send_prompt_writes_text_with_carriage_return() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::SendPrompt { session_id: "s1".into(), text: "hi".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Write { pty_id: "pty-a".into(), bytes: b"hi\r".to_vec() }
        );
    }

    #[test]
    fn send_prompt_unknown_session_is_rejected() {
        let reg = SessionPtyRegistry::new();
        let cmd = RemoteCommand::SendPrompt { session_id: "ghost".into(), text: "hi".into() };
        assert!(matches!(command_to_action(&cmd, &reg, false), PtyAction::Reject { .. }));
    }

    #[test]
    fn approve_writes_approve_keys() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::ApprovePermission { session_id: "s1".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Write { pty_id: "pty-a".into(), bytes: APPROVE_KEYS.as_bytes().to_vec() }
        );
    }

    #[test]
    fn deny_writes_deny_keys() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::DenyPermission { session_id: "s1".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Write { pty_id: "pty-a".into(), bytes: DENY_KEYS.as_bytes().to_vec() }
        );
    }

    #[test]
    fn stop_kills_the_pty() {
        let reg = reg_with("s1", "pty-a");
        let cmd = RemoteCommand::StopSession { session_id: "s1".into() };
        assert_eq!(
            command_to_action(&cmd, &reg, false),
            PtyAction::Kill { pty_id: "pty-a".into() }
        );
    }

    #[test]
    fn resume_spawns_only_when_allowed() {
        let reg = SessionPtyRegistry::new();
        let cmd = RemoteCommand::ResumeSession { session_id: "s1".into(), project_id: 7 };
        assert_eq!(
            command_to_action(&cmd, &reg, true),
            PtyAction::Spawn { session_id: "s1".into(), project_id: 7 }
        );
        assert!(matches!(command_to_action(&cmd, &reg, false), PtyAction::Reject { .. }));
    }

    #[test]
    fn session_to_bind_only_for_claude_with_id() {
        assert_eq!(
            session_to_bind(&PtyKind::Claude {
                session_id: Some("s1".into()), model: None, skip_permissions: false, fresh: true,
            }),
            Some("s1".to_string())
        );
        assert_eq!(
            session_to_bind(&PtyKind::Claude {
                session_id: None, model: None, skip_permissions: false, fresh: false,
            }),
            None
        );
        assert_eq!(session_to_bind(&PtyKind::Shell), None);
        assert_eq!(session_to_bind(&PtyKind::Action { action_id: 1 }), None);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::dispatch`
Expected: FAIL — `cannot find type PtyAction` / `command_to_action` not found.

- [ ] **Step 3: Write the implementation**

Insert above the `#[cfg(test)]` block in `src-tauri/src/remote/dispatch.rs`:

```rust
/// Concrete effect a remote command resolves to. Kept separate from execution
/// so the decision logic is pure and unit-testable without a real PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyAction {
    Write { pty_id: String, bytes: Vec<u8> },
    Kill { pty_id: String },
    Spawn { session_id: String, project_id: i64 },
    Reject { reason: String },
}

/// Key sequence sent to the Claude TUI to accept a permission prompt.
/// `\r` selects the highlighted (default "Yes") option.
pub const APPROVE_KEYS: &str = "\r";
/// Key sequence sent to cancel/reject a permission prompt. `\x1b` is Esc.
pub const DENY_KEYS: &str = "\x1b";

fn write_to_session(reg: &SessionPtyRegistry, session_id: &str, bytes: Vec<u8>) -> PtyAction {
    match reg.pty_for(session_id) {
        Some(pty_id) => PtyAction::Write { pty_id, bytes },
        None => PtyAction::Reject { reason: format!("no live pty for session {session_id}") },
    }
}

pub fn command_to_action(
    cmd: &RemoteCommand,
    reg: &SessionPtyRegistry,
    allow_spawn: bool,
) -> PtyAction {
    match cmd {
        RemoteCommand::SendPrompt { session_id, text } => {
            write_to_session(reg, session_id, format!("{text}\r").into_bytes())
        }
        RemoteCommand::ApprovePermission { session_id } => {
            write_to_session(reg, session_id, APPROVE_KEYS.as_bytes().to_vec())
        }
        RemoteCommand::DenyPermission { session_id } => {
            write_to_session(reg, session_id, DENY_KEYS.as_bytes().to_vec())
        }
        RemoteCommand::StopSession { session_id } => match reg.pty_for(session_id) {
            Some(pty_id) => PtyAction::Kill { pty_id },
            None => PtyAction::Reject { reason: format!("no live pty for session {session_id}") },
        },
        RemoteCommand::ResumeSession { session_id, project_id } => {
            if allow_spawn {
                PtyAction::Spawn { session_id: session_id.clone(), project_id: *project_id }
            } else {
                PtyAction::Reject { reason: "remote spawn disabled".into() }
            }
        }
    }
}

/// The session id (if any) that a freshly spawned PTY should be bound to in the
/// `SessionPtyRegistry`. Only Claude PTYs with a known session id qualify.
pub fn session_to_bind(kind: &PtyKind) -> Option<String> {
    match kind {
        PtyKind::Claude { session_id: Some(id), .. } => Some(id.clone()),
        _ => None,
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::dispatch`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote/dispatch.rs
git commit -m "feat(remote): add pure command-to-action dispatch"
```

---

### Task 5: Wire the registry into `AppState`

**Files:**
- Modify: `src-tauri/src/state.rs:1-33`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/state.rs`, inside the existing `#[cfg(test)] mod tests` block (after `clipboard_images_insert_and_remove`, before the closing brace at line 69), add:

```rust
    #[test]
    fn session_pty_registry_is_present_and_usable() {
        let state = test_state();
        state.session_pty.bind("sess-1", "pty-a");
        assert_eq!(state.session_pty.pty_for("sess-1"), Some("pty-a".to_string()));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml state::tests::session_pty_registry`
Expected: FAIL — `no field session_pty on type AppState`.

- [ ] **Step 3: Add the field and initializer**

In `src-tauri/src/state.rs`, add the import after line 7 (`use crate::pty::PtyManager;`):

```rust
use crate::remote::registry::SessionPtyRegistry;
```

Add the field to the `AppState` struct after line 12 (`pub pty: Arc<PtyManager>,`):

```rust
    pub session_pty: Arc<SessionPtyRegistry>,
```

Add the initializer inside `AppState::new`, after line 26 (`pty: PtyManager::new(),`):

```rust
            session_pty: Arc::new(SessionPtyRegistry::new()),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml state::tests::session_pty_registry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(remote): hold session-to-pty registry in app state"
```

---

### Task 6: Populate the registry on spawn, clear on kill

**Files:**
- Modify: `src-tauri/src/commands/pty.rs:118-122` (spawn) and `:145-149` (kill)

`spawn_pty` is not unit-testable end-to-end (it spawns a real process), so the binding *decision* is already covered by `session_to_bind` tests in Task 4. This task wires that decision in and is verified by build + the full suite.

- [ ] **Step 1: Add the import**

In `src-tauri/src/commands/pty.rs`, after line 8 (`use crate::db::{projects_repo, actions_repo};`), add:

```rust
use crate::remote::dispatch::session_to_bind;
```

- [ ] **Step 2: Bind the session after spawning**

In `spawn_pty`, replace the final line (currently line 121):

```rust
    state.pty.spawn(app, &program, &args_ref, &cwd, cols, rows, &env)
```

with:

```rust
    let pty_id = state.pty.spawn(app, &program, &args_ref, &cwd, cols, rows, &env)?;
    if let Some(session_id) = session_to_bind(&kind) {
        state.session_pty.bind(&session_id, &pty_id);
    }
    Ok(pty_id)
```

- [ ] **Step 3: Unbind on kill**

In `pty_kill` (line 146-149), add the unbind call after `cleanup_clipboard_images`:

```rust
#[tauri::command]
pub fn pty_kill(state: State<AppState>, pty_id: String) -> AppResult<()> {
    cleanup_clipboard_images(&state, &pty_id);
    state.session_pty.unbind_pty(&pty_id);
    state.pty.kill(&pty_id)
}
```

- [ ] **Step 4: Verify build and full Rust suite pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: builds; all tests pass (existing + the new `remote::*` and `state::*` tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pty.rs
git commit -m "feat(remote): bind session to pty on spawn, unbind on kill"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the full Rust suite**

Run: `npm run test:rust`
Expected: all tests pass.

- [ ] **Step 2: Run lint (TS types compile)**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 3: Confirm no stray placeholder modules remain**

Run: `grep -rn "implemented in subsequent tasks" src-tauri/src/remote/`
Expected: no output (every submodule has real content).

---

## Self-Review

**Spec coverage (vs `2026-05-30-abeoncloud-remote-bridge-design.md`):**
- Contract types (`RemoteCommand` / `RemoteEnvelope` / `RemoteEvent`, ts-rs export) → Task 2. ✓
- `sessionId → ptyId` registry → Tasks 3, 5, 6. ✓
- Command → action mapping (sendPrompt / approve / deny / stop / resume) → Task 4. ✓
- `resumeSession` gated behind an allow flag → Task 4 (`allow_spawn` param; the in-app `allowRemoteSpawn` *setting* that feeds this flag is plan 2b). ✓
- Deferred to 2b (explicitly out of scope here): event bus tap on `SessionWatchers`, async run-loop, real Centrifugo WS client, the `allowRemoteSpawn` setting + command registration, ACK publishing. ✓ (documented in scope note)

**Placeholder scan:** Task 1 intentionally writes `// implemented in subsequent tasks` stubs; Task 7 Step 3 verifies they are all replaced. No other placeholders.

**Type consistency:** `SessionPtyRegistry` methods (`new`, `bind`, `pty_for`, `unbind_pty`) are used identically in Tasks 3/5/6. `command_to_action(cmd, reg, allow_spawn)` and `session_to_bind(kind)` signatures match between Task 4 definition and Task 6 use. `PtyAction` variants used in tests match the definition. `RemoteCommand` field names (`session_id`, `text`, `project_id`) are consistent across protocol and dispatch.
