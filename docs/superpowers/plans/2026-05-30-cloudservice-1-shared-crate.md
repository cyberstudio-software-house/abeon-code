# CloudService Plan 1 — Shared `abeon-remote-core` crate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the remote command/token/validation contract out of `DesktopApp/src-tauri` into a standalone `crates/abeon-remote-core` library crate that both the desktop and the future CloudService depend on by path, so the two can never drift.

**Architecture:** New standalone lib crate `crates/abeon-remote-core` (NOT a Cargo workspace member — path dependency only, so Tauri's `target/` is not relocated). The crate owns `protocol` (the `#[derive(TS)]` command/event types), `token` (HS256 Centrifugo JWT minting), and `validation` (the network-input allowlists) with its own lightweight `ValidationError`. The existing desktop modules (`remote/protocol.rs`, `remote/token.rs`, `validation.rs`) become thin re-export / adapter facades, so all existing call sites compile unchanged.

**Tech Stack:** Rust (edition 2021), serde, ts-rs 11, jsonwebtoken 9, thiserror 2, anyhow 1.

---

## Context the implementer needs

- **This is a move-refactor, not new behavior.** The existing tests are the safety net: after each task the relevant test suite must stay green. "Write the failing test" is replaced by "move the existing tests; run them; they must pass."
- **No Cargo workspace.** Do NOT add a `[workspace]` to a root `Cargo.toml`. The desktop depends on the new crate via a `path = ` dependency only. Reason: a workspace relocates `DesktopApp/src-tauri/target/`, which bakes absolute paths (documented gotcha in `DesktopApp/CLAUDE.md`).
- **`AppError` does NOT move.** The desktop's `crate::error::AppError` carries `git2`/`rusqlite`/etc. variants — it is desktop-specific. The crate defines its own `ValidationError`; the desktop facade maps it back to `AppError::InvalidInput(..)` so the four existing call sites (`commands/pty.rs:70,100,103`, `sessions/reader.rs:24`) keep their `AppResult<()>` contract.
- **ts-rs generation moves.** Today the desktop's `cargo test` regenerates `DesktopApp/src/types/RemoteCommand.ts` etc. After extraction, those `#[ts(export)]` types live in the crate, so regeneration is `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`. The `export_to` path becomes `../../DesktopApp/src/types/` (relative to the crate manifest dir).
- **Verify commands run from the repo root** `/home/pszweda/projects/cyberstudio/AbeonCode` unless stated otherwise.

## File structure (what this plan creates / modifies)

- Create: `crates/abeon-remote-core/Cargo.toml`
- Create: `crates/abeon-remote-core/src/lib.rs` — module declarations
- Create: `crates/abeon-remote-core/src/protocol.rs` — moved `RemoteCommand`/`RemoteEnvelope`/`RemoteEvent` + tests
- Create: `crates/abeon-remote-core/src/token.rs` — moved minting fns + tests
- Create: `crates/abeon-remote-core/src/validation.rs` — moved allowlists + new `ValidationError` + tests
- Modify: `DesktopApp/src-tauri/Cargo.toml` — add the path dependency
- Modify: `DesktopApp/src-tauri/src/remote/protocol.rs` — becomes `pub use` facade
- Modify: `DesktopApp/src-tauri/src/remote/token.rs` — becomes `pub use` facade
- Modify: `DesktopApp/src-tauri/src/validation.rs` — becomes adapter facade (maps `ValidationError` → `AppError::InvalidInput`)
- Modify: `DesktopApp/CLAUDE.md` — update the ts-rs regeneration note

---

### Task 1: Scaffold the crate

**Files:**
- Create: `crates/abeon-remote-core/Cargo.toml`
- Create: `crates/abeon-remote-core/src/lib.rs`

- [ ] **Step 1: Write `crates/abeon-remote-core/Cargo.toml`**

```toml
[package]
name = "abeon-remote-core"
version = "0.1.0"
edition = "2021"

[lib]
name = "abeon_remote_core"
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
thiserror = "2"
anyhow = "1"
ts-rs = { version = "11", features = ["serde-compat"] }
jsonwebtoken = "9"

[dev-dependencies]
serde_json = "1"
```

- [ ] **Step 2: Write `crates/abeon-remote-core/src/lib.rs`**

```rust
//! Shared remote-control contract for AbeonCloud: the command/event protocol,
//! Centrifugo JWT minting, and the network-input validation allowlists.
//! Depended on by both the desktop bridge and CloudService so the two cannot drift.

pub mod protocol;
pub mod token;
pub mod validation;
```

- [ ] **Step 3: Add empty module files so the crate compiles**

Create `crates/abeon-remote-core/src/protocol.rs`, `src/token.rs`, `src/validation.rs` each containing a single placeholder line:

```rust
// filled in by the next tasks
```

- [ ] **Step 4: Verify the crate builds**

Run: `cargo build --manifest-path crates/abeon-remote-core/Cargo.toml`
Expected: `Finished` with no errors (empty modules compile).

- [ ] **Step 5: Commit**

```bash
git add crates/abeon-remote-core/Cargo.toml crates/abeon-remote-core/src/
git commit -m "feat(remote-core): scaffold shared abeon-remote-core crate"
```

---

### Task 2: Move `validation` into the crate (with its own error)

**Files:**
- Modify: `crates/abeon-remote-core/src/validation.rs`

- [ ] **Step 1: Write the full module with `ValidationError` and the moved tests**

Replace the placeholder contents of `crates/abeon-remote-core/src/validation.rs` with:

```rust
//! Network-input allowlists. This is the trust boundary for remote
//! (mobile-originated) input: `session_id` is used both as a `claude` CLI
//! argument and as a `<id>.jsonl` filename stem; `model` is passed to
//! `claude --model`. The allowlists make those values safe on every surface.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ValidationError(pub String);

pub type ValidationResult = Result<(), ValidationError>;

/// Claude session ids are UUIDs (36 chars); allow some headroom.
const MAX_SESSION_ID_LEN: usize = 64;
const MAX_MODEL_LEN: usize = 128;

/// Allowlist `[A-Za-z0-9_-]`, non-empty, bounded, no leading `-`. Cannot contain
/// shell metacharacters, whitespace, quotes, a flag-style `-` prefix, or `/`/`.`
/// (so `join`-based path traversal is impossible).
pub fn validate_session_id(id: &str) -> ValidationResult {
    if id.is_empty() || id.len() > MAX_SESSION_ID_LEN {
        return Err(ValidationError(format!(
            "session id length out of range (1..={MAX_SESSION_ID_LEN})"
        )));
    }
    if id.starts_with('-') {
        return Err(ValidationError("session id must not start with '-'".into()));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(ValidationError(
            "session id may contain only [A-Za-z0-9_-]".into(),
        ));
    }
    Ok(())
}

/// Validate a model identifier passed to `claude --model`. Allowlist
/// `[A-Za-z0-9._/\[\]-]`, non-empty, bounded, no leading `-`.
pub fn validate_model(model: &str) -> ValidationResult {
    if model.is_empty() || model.len() > MAX_MODEL_LEN {
        return Err(ValidationError("model length out of range".into()));
    }
    if model.starts_with('-') {
        return Err(ValidationError("model must not start with '-'".into()));
    }
    if !model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '[' | ']' | '-'))
    {
        return Err(ValidationError("model contains invalid characters".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_uuid_session_id() {
        assert!(validate_session_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_session_id("new_session-1").is_ok());
    }

    #[test]
    fn rejects_path_traversal_session_id() {
        assert!(validate_session_id("../../../../etc/passwd").is_err());
        assert!(validate_session_id("..").is_err());
        assert!(validate_session_id("a/b").is_err());
        assert!(validate_session_id("/etc/shadow").is_err());
    }

    #[test]
    fn rejects_shell_metacharacters_session_id() {
        assert!(validate_session_id("s1; rm -rf /").is_err());
        assert!(validate_session_id("$(whoami)").is_err());
        assert!(validate_session_id("a`b`").is_err());
        assert!(validate_session_id("a b").is_err());
    }

    #[test]
    fn rejects_leading_dash_and_empty_and_overlong() {
        assert!(validate_session_id("-rf").is_err());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn model_accepts_known_shapes() {
        assert!(validate_model("opus").is_ok());
        assert!(validate_model("claude-opus-4-8").is_ok());
        assert!(validate_model("claude-sonnet-4-6").is_ok());
    }

    #[test]
    fn model_rejects_injection_and_flag_smuggling() {
        assert!(validate_model("opus; rm -rf /").is_err());
        assert!(validate_model("$(id)").is_err());
        assert!(validate_model("--dangerously-skip-permissions").is_err());
        assert!(validate_model("").is_err());
    }
}
```

- [ ] **Step 2: Run the crate's validation tests**

Run: `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml validation`
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/abeon-remote-core/src/validation.rs
git commit -m "feat(remote-core): add validation allowlists with ValidationError"
```

---

### Task 3: Move `token` into the crate

**Files:**
- Modify: `crates/abeon-remote-core/src/token.rs`

- [ ] **Step 1: Write the full module (verbatim move of the existing minting fns + tests)**

Replace the placeholder contents of `crates/abeon-remote-core/src/token.rs` with:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct ConnectClaims {
    sub: String,
    exp: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
}

/// Mint a Centrifugo connection JWT (HS256) for device `sub`, valid `ttl_secs`.
/// `now_unix` is injected so the function stays pure/testable.
pub fn mint_connection_token(
    secret: &str,
    sub: &str,
    now_unix: usize,
    ttl_secs: usize,
) -> anyhow::Result<String> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let claims = ConnectClaims { sub: sub.to_string(), exp: now_unix + ttl_secs, channel: None };
    Ok(encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}

/// Mint a channel subscription JWT (HS256) — used only if the deployment gates channels.
pub fn mint_subscription_token(
    secret: &str,
    sub: &str,
    channel: &str,
    now_unix: usize,
    ttl_secs: usize,
) -> anyhow::Result<String> {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let claims = ConnectClaims {
        sub: sub.to_string(),
        exp: now_unix + ttl_secs,
        channel: Some(channel.to_string()),
    };
    Ok(encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

    /// Validation that ignores expiry, so claim round-trips don't depend on wall clock.
    fn lax_validation() -> Validation {
        let mut v = Validation::new(Algorithm::HS256);
        v.validate_exp = false;
        v.required_spec_claims.clear();
        v
    }

    #[test]
    fn connection_token_round_trips() {
        let secret = "test-secret";
        let token = mint_connection_token(secret, "device-1", 1_000, 3600).unwrap();
        let data = decode::<ConnectClaims>(
            &token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &lax_validation(),
        )
        .unwrap();
        assert_eq!(data.claims.sub, "device-1");
        assert_eq!(data.claims.exp, 4_600);
        assert_eq!(data.claims.channel, None);
    }

    #[test]
    fn subscription_token_carries_channel() {
        let secret = "test-secret";
        let token = mint_subscription_token(secret, "device-1", "cmd:device-1", 0, 60).unwrap();
        let data = decode::<ConnectClaims>(
            &token,
            &DecodingKey::from_secret(secret.as_bytes()),
            &lax_validation(),
        )
        .unwrap();
        assert_eq!(data.claims.channel.as_deref(), Some("cmd:device-1"));
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let token = mint_connection_token("right", "d", 0, 60).unwrap();
        let res = decode::<ConnectClaims>(
            &token,
            &DecodingKey::from_secret(b"wrong"),
            &lax_validation(),
        );
        assert!(res.is_err());
    }
}
```

- [ ] **Step 2: Run the crate's token tests**

Run: `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml token`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/abeon-remote-core/src/token.rs
git commit -m "feat(remote-core): add Centrifugo HS256 token minting"
```

---

### Task 4: Move `protocol` into the crate and retarget ts-rs export

**Files:**
- Modify: `crates/abeon-remote-core/src/protocol.rs`

- [ ] **Step 1: Write the full module (note the changed `export_to` path)**

Replace the placeholder contents of `crates/abeon-remote-core/src/protocol.rs` with the following. The ONLY change from the desktop original is `export_to = "../../DesktopApp/src/types/"` (three occurrences), because the crate manifest dir is `crates/abeon-remote-core/`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../DesktopApp/src/types/")]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum RemoteCommand {
    SendPrompt {
        session_id: String,
        text: String,
    },
    ApprovePermission {
        session_id: String,
    },
    DenyPermission {
        session_id: String,
    },
    StopSession {
        session_id: String,
    },
    ResumeSession {
        session_id: String,
        #[ts(type = "number")]
        project_id: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../DesktopApp/src/types/")]
#[serde(rename_all = "camelCase")]
pub struct RemoteEnvelope {
    pub command_id: String,
    pub command: RemoteCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../DesktopApp/src/types/")]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum RemoteEvent {
    CmdResult {
        command_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
}

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

- [ ] **Step 2: Run the crate's protocol tests AND confirm TS regeneration**

Run: `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`
Expected: all tests pass (protocol 4 + token 3 + validation 6, plus ts-rs `export_bindings_*` tests).

Then confirm the TS files were (re)written to the desktop, unchanged:

Run: `git status --short DesktopApp/src/types/`
Expected: no changes (the regenerated files are byte-identical to the committed ones — the contract did not change, only its source location).

- [ ] **Step 3: Commit**

```bash
git add crates/abeon-remote-core/src/protocol.rs
git commit -m "feat(remote-core): add RemoteCommand/Envelope/Event protocol with ts-rs export"
```

---

### Task 5: Point the desktop at the crate via facades

**Files:**
- Modify: `DesktopApp/src-tauri/Cargo.toml`
- Modify: `DesktopApp/src-tauri/src/remote/protocol.rs`
- Modify: `DesktopApp/src-tauri/src/remote/token.rs`
- Modify: `DesktopApp/src-tauri/src/validation.rs`

- [ ] **Step 1: Add the path dependency to `DesktopApp/src-tauri/Cargo.toml`**

In the `[dependencies]` section, add (alphabetical placement near the top is fine):

```toml
abeon-remote-core = { path = "../../crates/abeon-remote-core" }
```

- [ ] **Step 2: Replace `DesktopApp/src-tauri/src/remote/protocol.rs` with a re-export facade**

Full new file contents:

```rust
//! Moved to the shared `abeon-remote-core` crate. Re-exported here so existing
//! `crate::remote::protocol::*` call sites compile unchanged.
pub use abeon_remote_core::protocol::*;
```

- [ ] **Step 3: Replace `DesktopApp/src-tauri/src/remote/token.rs` with a re-export facade**

Full new file contents:

```rust
//! Moved to the shared `abeon-remote-core` crate. Re-exported here so existing
//! `crate::remote::token::*` call sites compile unchanged.
pub use abeon_remote_core::token::*;
```

- [ ] **Step 4: Replace `DesktopApp/src-tauri/src/validation.rs` with an adapter facade**

The crate returns `ValidationError`; the desktop call sites expect `AppResult<()>`. Map the error to `AppError::InvalidInput` so messages and behavior are identical. Full new file contents:

```rust
//! Network-input validation now lives in the shared `abeon-remote-core` crate.
//! These thin adapters preserve the desktop's `AppResult<()>` contract by mapping
//! `ValidationError` to `AppError::InvalidInput`.
use crate::error::{AppError, AppResult};

fn adapt(r: abeon_remote_core::validation::ValidationResult) -> AppResult<()> {
    r.map_err(|e| AppError::InvalidInput(e.0))
}

pub fn validate_session_id(id: &str) -> AppResult<()> {
    adapt(abeon_remote_core::validation::validate_session_id(id))
}

pub fn validate_model(model: &str) -> AppResult<()> {
    adapt(abeon_remote_core::validation::validate_model(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_invalid_session_id_to_invalid_input() {
        let err = validate_session_id("../etc/passwd").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn accepts_valid_inputs() {
        assert!(validate_session_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_model("claude-opus-4-8").is_ok());
    }
}
```

- [ ] **Step 5: Build and run the full desktop Rust suite**

Run: `npm --prefix DesktopApp run test:rust`
Expected: all 183 existing tests still pass (now including the crate via the path dep; the 2 new facade tests bring the desktop count up accordingly). No compile errors.

- [ ] **Step 6: Run the frontend type-check (the generated TS must still satisfy `tsc`)**

Run: `npm --prefix DesktopApp run lint`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add DesktopApp/src-tauri/Cargo.toml DesktopApp/src-tauri/src/remote/protocol.rs \
        DesktopApp/src-tauri/src/remote/token.rs DesktopApp/src-tauri/src/validation.rs \
        DesktopApp/src-tauri/Cargo.lock
git commit -m "refactor(remote): consume abeon-remote-core from the desktop via facades"
```

---

### Task 6: Document the new ts-rs regeneration path

**Files:**
- Modify: `DesktopApp/CLAUDE.md`

- [ ] **Step 1: Update the ts-rs gotcha note**

In `DesktopApp/CLAUDE.md`, find the bullet:

```
- **ts-rs exports `src/types/*.ts` during `cargo test`, NOT `cargo build`**. After adding `#[derive(TS)]`, run `cargo test` once to materialize the file.
```

Replace it with:

```
- **ts-rs exports `src/types/*.ts` during `cargo test`, NOT `cargo build`**. After adding `#[derive(TS)]`, run `cargo test` once to materialize the file. **Remote-contract types** (`RemoteCommand`/`RemoteEnvelope`/`RemoteEvent`) now live in the shared `crates/abeon-remote-core` crate; regenerate them with `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml` (they still emit into `DesktopApp/src/types/`).
```

- [ ] **Step 2: Commit**

```bash
git add DesktopApp/CLAUDE.md
git commit -m "docs(desktop): note remote-contract ts-rs regeneration moved to abeon-remote-core"
```

---

## Self-Review

**Spec coverage (against the design's "Shared crate (anti-drift)" section):**
- Standalone crate, path dependency, no mega-workspace → Tasks 1 & 5. ✓
- `protocol` / `validation` / `token` moved → Tasks 2, 3, 4. ✓
- Facades preserve call sites → Task 5 (covers `commands/pty.rs`, `sessions/reader.rs`, `remote/startup.rs`, `remote/ws_client.rs`, and the 6 `remote/` protocol consumers via `pub use`). ✓
- ts-rs `export_to` retargeted, TS still lands in `DesktopApp/src/types/` → Task 4 Step 1 + Step 2 verification. ✓
- `AppError` stays desktop-side; crate uses `ValidationError` → Task 2 + Task 5 Step 4. ✓
- Desktop suite + lint stay green → Task 5 Steps 5–6. ✓

**Placeholder scan:** No "TBD"/"add error handling"/"similar to" — every file is shown in full. ✓

**Type consistency:** `ValidationError(pub String)` defined in Task 2 is consumed as `e.0` in Task 5 Step 4. `ValidationResult` alias defined in Task 2, used in the `adapt` signature in Task 5. `mint_connection_token`/`mint_subscription_token` signatures unchanged from the original, so `startup.rs`/`ws_client.rs` callers are unaffected. ✓

**Risk note for the executor:** if `git status --short DesktopApp/src/types/` in Task 4 Step 2 shows changes, the `export_to` path is wrong — re-check it resolves to repo-root `DesktopApp/src/types/` from `crates/abeon-remote-core/`. Do not commit regenerated TS that differs from the committed contract.
```
