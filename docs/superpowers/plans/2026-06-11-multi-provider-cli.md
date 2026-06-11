# Multi-Provider CLI Support (Claude Code + Codex) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the desktop app drive sessions of more than one AI CLI (Claude Code + OpenAI Codex): a provider picker tab on "New session" when >1 CLI is enabled in settings, a merged session list per project, and provider icons (tinted by activity status) replacing the status dots.

**Architecture:** A `Provider` enum (`claude` | `codex`) flows through the whole stack. The Rust backend gets a provider seam: `PtyKind::Agent { provider, … }` replaces `PtyKind::Claude`, command building / session discovery / JSONL parsing / activity detection dispatch per provider. Claude keeps its current per-project `~/.claude/projects/<encoded>/` reader; Codex gets a new reader over the global `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)` tree filtered by `cwd`, with results mapped into the existing provider-agnostic `HistoryBlock`/`SessionMeta` types. The frontend gains an `enabledProviders` setting, a new `providerPicker` tab kind, and provider-aware session items. Codex cannot pre-assign a session id (`--session-id` does not exist), so fresh Codex tabs reuse the existing `new-…` placeholder + `refreshActivity` linking mechanism that already lives in `sessionsSlice`.

**Tech Stack:** Rust (Tauri 2, serde, ts-rs, notify, zstd), React 19 + Zustand 5 + Tailwind 4, Vitest, cargo test.

All paths are relative to `DesktopApp/` unless prefixed with `docs/` or `crates/`. Run npm/cargo commands from `DesktopApp/` (`cargo` commands from `DesktopApp/src-tauri/`).

---

## Design decisions (v1 scope)

These were decided during planning; do not silently expand scope:

1. **Remote bridge stays Claude-only.** `roster_snapshot` keeps calling the Claude-only `reader::list_sessions`, so Codex sessions never reach the mobile roster. `spawn_claude_resume` stays untouched. Multi-provider remote is a future plan.
2. **Codex fresh-session linking reuses the `new-` placeholder flow.** `sessionsSlice.refreshActivity` already links unlinked `new-…` tabs to newly appeared sessions; we only make the matching provider-aware. No backend watcher/event needed.
3. **Model selection applies to Claude only.** Codex spawns with the user's `~/.codex/config.toml` defaults; the `model` field is never sent for Codex in v1.
4. **Title generation keeps using `claude -p`** even for Codex sessions (it only reads the first user prompt and calls the Claude binary). If `claude` is missing the existing error path shows in the dialog — acceptable.
5. **Usage/cost tracking is skipped for Codex** (`UsageAccumulator` stays Claude-only; Codex sessions report no usage).
6. **`skipPermissions` maps to `--dangerously-bypass-approvals-and-sandbox`** for Codex.
7. **Provider icons are simple monochrome glyphs** (8-ray starburst for Claude, hexagon for Codex) colored via `currentColor`, so the activity tint works the same way the dots did. Swapping in exact brand SVG paths later is a one-line change per icon.
8. **Codex listing always runs** (no gating on `enabledProviders`): if `~/.codex/sessions` doesn't exist the reader returns `[]` for free. This means past Codex sessions show up even if the user later disables the provider — intended.

## Known risk (verify in Task 0)

The Codex rollout format below is based on documentation of codex-cli `0.139.0` (installed on this machine): first line `session_meta` (payload: `id`, `cwd`, `cli_version`…), then `response_item` / `event_msg` / `turn_context` lines, possibly `.jsonl.zst`-compressed. **Task 0 captures a real fixture and verifies every assumption.** If the real format differs, adjust the fixture + parser in Tasks 5–7 accordingly (the task code is written against the documented shape).

## File structure

**New files:**

| File | Responsibility |
|---|---|
| `src-tauri/src/domain/provider.rs` | `Provider` enum (ts-rs exported) |
| `src-tauri/src/sessions/codex/mod.rs` | module wiring |
| `src-tauri/src/sessions/codex/reader.rs` | rollout discovery, meta cache, listing by cwd, history reading, zst support |
| `src-tauri/src/sessions/codex/parser.rs` | rollout line → `Vec<HistoryBlock>` |
| `src-tauri/src/sessions/codex/activity.rs` | `LastEvent` extractor for rollout tails |
| `src-tauri/src/commands/providers.rs` | `detect_providers` command |
| `src-tauri/tests/fixtures/codex-rollout.jsonl` | parser/reader test fixture |
| `src/lib/providers.ts` | provider labels/icons constants |
| `src/components/center/ProviderPicker.tsx` | provider picker tab content |
| `src/store/tabsSlice.test.ts` | tests for picker/branching logic |

**Modified (main ones):** `domain/session.rs` (+`provider` on `SessionMeta`), `commands/pty.rs` (`PtyKind::Agent`, codex command), `commands/sessions.rs` (merged list, provider dispatch), `commands/models.rs` (`locate_binary`), `sessions/activity.rs` (extractor seam), `sessions/watcher.rs` (per-session provider), `remote/dispatch.rs` (`session_to_bind`), `lib.rs` (register command), `Cargo.toml` (zstd); frontend: `lib/tauri.ts`, `lib/activity.ts`, `lib/windowMode.ts`, `store/settingsSlice.ts`, `store/tabsSlice.ts`, `store/sessionsSlice.ts`, `store/index.ts`, `components/terminal/TerminalView.tsx`, `components/center/TabContent.tsx`, `components/center/TabBar.tsx`, `components/sidebar/SessionItem.tsx`, `components/sidebar/SessionList.tsx`, `components/dialogs/SettingsDialog.tsx`, `components/shared/Icon.tsx`, `src/types/index.ts`.

---

### Task 0: Codex recon — capture a real rollout fixture

**Requires the user** (interactive `codex login`). Do this before Tasks 5–7; Tasks 1–4 don't depend on it.

**Files:**
- Create: `src-tauri/tests/fixtures/codex-rollout.jsonl` (sanitized real capture)

- [ ] **Step 1: Log in and produce a throwaway session** (user runs login):

```bash
codex login                      # user action, opens browser
mkdir -p /tmp/codex-recon && cd /tmp/codex-recon
codex exec --skip-git-repo-check "Run the command: ls. Then reply with one word: done"
```

- [ ] **Step 2: Inspect what was written**

```bash
find ~/.codex/sessions -type f | head
head -c 3000 "$(find ~/.codex/sessions -type f | head -1)"
```

Verify and note for later tasks:
- file extension: `.jsonl` or `.jsonl.zst` (if `.zst`: `zstd -dc <file> | head -c 3000`)
- first line is `{"timestamp":…,"type":"session_meta","payload":{"id":"<uuid>","cwd":"/tmp/codex-recon",…}}`
- `response_item` payload shapes for: user/assistant `message`, `reasoning`, `function_call`, `function_call_output`
- whether `payload.git.branch` exists in `session_meta`

- [ ] **Step 3: Copy a sanitized version to the fixture path.** Keep ≤ ~15 lines covering: `session_meta`, a meta user message (`<user_instructions>`/`<environment_context>` if present), a real user message, `reasoning`, `function_call` + `function_call_output`, an assistant `message`, one `event_msg`. Replace any private text. If the real shapes differ from the synthetic fixture shown in Task 6, **fix the Task 6 fixture/tests to match reality** before implementing.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/fixtures/codex-rollout.jsonl
git commit -m "test(desktop): add codex rollout fixture from real capture"
```

---

### Task 1: `Provider` enum + `SessionMeta.provider`

**Files:**
- Create: `src-tauri/src/domain/provider.rs`
- Modify: `src-tauri/src/domain/mod.rs`, `src-tauri/src/domain/session.rs:17-29`, `src-tauri/src/sessions/reader.rs:147,243`, `src/types/index.ts`
- Test: inline `#[cfg(test)]` in `provider.rs`

- [ ] **Step 1: Write the failing test** — create `src-tauri/src/domain/provider.rs`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn id(&self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case() {
        assert_eq!(serde_json::to_string(&Provider::Claude).unwrap(), "\"claude\"");
        assert_eq!(serde_json::to_string(&Provider::Codex).unwrap(), "\"codex\"");
    }

    #[test]
    fn deserializes_camel_case() {
        assert_eq!(serde_json::from_str::<Provider>("\"codex\"").unwrap(), Provider::Codex);
    }
}
```

In `src-tauri/src/domain/mod.rs` add the module + re-export next to the existing ones:

```rust
pub mod provider;
pub use provider::Provider;
```

- [ ] **Step 2: Run** `cargo test domain::provider -- --nocapture` — expect PASS (the enum compiles with its tests). Then add `provider` to `SessionMeta` in `src-tauri/src/domain/session.rs` (after the `activity` field):

```rust
    pub activity: SessionActivity,
    pub provider: Provider,
```

with `use super::Provider;` at the top. Run `cargo test` — expect FAIL: `reader.rs` constructors miss the field.

- [ ] **Step 3: Fix the two `SessionMeta` constructors** in `src-tauri/src/sessions/reader.rs` (`meta_for_file_fast` ~line 147 and `read_history` ~line 243) — add to both struct literals:

```rust
        provider: crate::domain::Provider::Claude,
```

- [ ] **Step 4: Run** `cd src-tauri && cargo test` — expect PASS. This also regenerates `src/types/Provider.ts` and `src/types/SessionMeta.ts` (ts-rs exports during `cargo test`, not build).

- [ ] **Step 5: Re-export the TS type.** In `src/types/index.ts` add (matching the existing generated-type re-export lines):

```ts
export type { Provider } from './Provider';
```

Run `npm run lint` — expect 0 errors.

- [ ] **Step 6: Commit**

```bash
git add -A src-tauri/src/domain src-tauri/src/sessions/reader.rs src/types
git commit -m "feat(desktop): add Provider enum and provider field on SessionMeta"
```

---

### Task 2: `PtyKind::Agent` + per-provider command building (backend)

**Files:**
- Modify: `src-tauri/src/commands/pty.rs`, `src-tauri/src/remote/dispatch.rs:85-90` (+ its tests ~178-190)
- Test: existing `#[cfg(test)]` in both files

- [ ] **Step 1: Write the failing tests** — in `src-tauri/src/commands/pty.rs` tests module add:

```rust
    #[test]
    fn codex_command_fresh_plain() {
        assert_eq!(
            build_agent_command(Provider::Codex, None, None, false, true),
            "codex"
        );
    }

    #[test]
    fn codex_command_resume() {
        assert_eq!(
            build_agent_command(Provider::Codex, Some("uuid-1"), None, false, false),
            "codex resume uuid-1"
        );
    }

    #[test]
    fn codex_command_skip_permissions() {
        assert_eq!(
            build_agent_command(Provider::Codex, None, None, true, true),
            "codex --dangerously-bypass-approvals-and-sandbox"
        );
    }

    #[test]
    fn codex_command_resume_ignores_model() {
        assert_eq!(
            build_agent_command(Provider::Codex, Some("uuid-1"), Some("gpt-x"), false, false),
            "codex resume uuid-1"
        );
    }

    #[test]
    fn claude_command_via_agent_dispatch() {
        assert_eq!(
            build_agent_command(Provider::Claude, Some("uuid-1"), None, false, true),
            "claude --session-id uuid-1"
        );
    }
```

- [ ] **Step 2: Run** `cargo test commands::pty` — expect FAIL: `build_agent_command` not found.

- [ ] **Step 3: Implement.** In `src-tauri/src/commands/pty.rs`:

Add `use crate::domain::Provider;`. Replace the `PtyKind::Claude` variant:

```rust
pub enum PtyKind {
    Agent {
        provider: Provider,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        skip_permissions: bool,
        #[serde(default)]
        fresh: bool,
    },
    Action {
        #[ts(type = "number")]
        action_id: i64,
    },
    Shell,
}
```

Below `build_claude_command` add:

```rust
fn build_codex_command(session_id: Option<&str>, model: Option<&str>, skip_permissions: bool, fresh: bool) -> String {
    let mut cmd = String::from("codex");
    match session_id {
        Some(id) if !fresh => cmd.push_str(&format!(" resume {id}")),
        _ => {
            if let Some(m) = model {
                cmd.push_str(&format!(" -m {m}"));
            }
        }
    }
    if skip_permissions {
        cmd.push_str(" --dangerously-bypass-approvals-and-sandbox");
    }
    cmd
}

fn build_agent_command(
    provider: Provider,
    session_id: Option<&str>,
    model: Option<&str>,
    skip_permissions: bool,
    fresh: bool,
) -> String {
    match provider {
        Provider::Claude => build_claude_command(session_id, model, skip_permissions, fresh),
        Provider::Codex => build_codex_command(session_id, model, skip_permissions, fresh),
    }
}
```

In `spawn_pty`, change the match arm `PtyKind::Claude { session_id, model, skip_permissions, fresh }` to:

```rust
        PtyKind::Agent { provider, session_id, model, skip_permissions, fresh } => {
            if let Some(id) = session_id {
                crate::validation::validate_session_id(id)?;
            }
            if let Some(m) = model {
                crate::validation::validate_model(m)?;
            }
            let cmd = build_agent_command(
                *provider,
                session_id.as_deref(),
                model.as_deref(),
                *skip_permissions,
                *fresh,
            );
            (
                "bash".to_string(),
                vec!["-c".to_string(), cmd],
            )
        }
```

(Keep the existing safety comment about untrusted `session_id`.) `spawn_claude_resume` keeps calling `build_claude_command` directly — unchanged.

In `src-tauri/src/remote/dispatch.rs` update `session_to_bind` — only fresh Claude tabs pre-assign their id; resumes are bound by the caller; Codex never has an upfront id:

```rust
pub fn session_to_bind(kind: &PtyKind) -> Option<String> {
    match kind {
        PtyKind::Agent { provider: Provider::Claude, session_id: Some(id), .. } => Some(id.clone()),
        _ => None,
    }
}
```

with `use crate::domain::Provider;`. Update its tests (~line 178) to construct `PtyKind::Agent { provider: Provider::Claude, … }` instead of `PtyKind::Claude { … }`, and add one asserting Codex never binds:

```rust
    #[test]
    fn session_to_bind_none_for_codex() {
        assert_eq!(
            session_to_bind(&PtyKind::Agent {
                provider: Provider::Codex,
                session_id: Some("s1".into()), model: None, skip_permissions: false, fresh: true,
            }),
            None
        );
    }
```

- [ ] **Step 4: Run** `cargo test` — expect PASS (this regenerates `src/types/PtyKind.ts`). `npm run lint` will now FAIL on the frontend — that's Task 3.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pty.rs src-tauri/src/remote/dispatch.rs src/types/PtyKind.ts
git commit -m "feat(desktop): provider-aware PtyKind::Agent with codex command building"
```

---

### Task 3: Frontend spawn path follows `PtyKind::Agent`

**Files:**
- Modify: `src/lib/tauri.ts:14-15`, `src/components/terminal/TerminalView.tsx:14,149-151`, `src/components/center/TabContent.tsx`, `src/lib/windowMode.ts`, `src/store/tabsSlice.ts` (Tab type + `sessionTabFromMode`)
- Test: `npm run lint` + existing vitest suite

- [ ] **Step 1: Update the IPC client type.** In `src/lib/tauri.ts` replace the `PtyKindClient` claude variant:

```ts
import type { Provider } from '../types';

export type PtyKindClient =
  | { kind: 'agent'; provider: Provider; session_id?: string; model?: string; skip_permissions?: boolean; fresh?: boolean }
  | { kind: 'action'; action_id: number }
  | { kind: 'shell' };
```

(Keep the snake_case field convention comment.)

- [ ] **Step 2: Extend the `Tab` session variant** in `src/store/tabsSlice.ts`:

```ts
  | { kind: 'session'; id: string; projectId: number; sessionId: string; linkedSessionId?: string; title: string; mode: 'history' | 'terminal'; fresh?: boolean; provider?: Provider }
```

with `import type { Provider } from '../types';`. In `sessionTabFromMode` spread the provider:

```ts
    ...(mode.provider ? { provider: mode.provider } : {}),
```

- [ ] **Step 3: Thread provider through detached windows.** In `src/lib/windowMode.ts`: add `provider?: Provider` to `WindowMode` (import the type), parse it in `parseWindowMode`:

```ts
  const provider: Provider | undefined = q.get('provider') === 'codex' ? 'codex' : undefined;
```

and spread `...(provider ? { provider } : {})` into the returned object. In `buildSessionWindowUrl` accept `provider?: Provider` in the params object and add:

```ts
  if (p.provider) q.set('provider', p.provider);
```

Find the `buildSessionWindowUrl` caller (`grep -rn buildSessionWindowUrl src/`) and pass `provider: tab.provider` from the session tab.

- [ ] **Step 4: Update `TerminalView`.** In `src/components/terminal/TerminalView.tsx`: change the props type at line 14 to `kind: 'agent' | 'action' | 'shell';` and add `provider?: Provider;` (import the type). Replace the ptyKind construction (~line 149):

```ts
    const agentProvider = provider ?? 'claude';
    const ptyKind: PtyKindClient =
      kind === 'agent'
        ? {
            kind: 'agent',
            provider: agentProvider,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(agentProvider === 'claude' && cliModel ? { model: cliModel } : {}),
            ...(fresh ? { fresh: true } : {}),
            ...(skipPermissions ? { skip_permissions: true } : {}),
          }
        : /* action/shell branches unchanged */
```

Add `provider` to the spawn `useEffect` dependency array if `kind`/`sessionId` are already there.

- [ ] **Step 5: Update `TabContent.tsx`** — session branches pass the provider; Codex fresh tabs must NOT send their `new-…` placeholder as a session id:

```tsx
  if (tab.kind === 'session' && tab.mode === 'terminal') {
    const provider = tab.provider ?? 'claude';
    if (tab.fresh) {
      return (
        <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
          <TerminalView
            projectId={tab.projectId}
            kind="agent"
            provider={provider}
            sessionId={provider === 'claude' ? tab.sessionId : undefined}
            fresh
            visible={visible}
          />
        </div>
      );
    }
    const resumeId = tab.linkedSessionId ?? (tab.sessionId.startsWith('new-') ? undefined : tab.sessionId);
    return (
      <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
        <TerminalView projectId={tab.projectId} kind="agent" provider={provider} sessionId={resumeId} visible={visible} />
      </div>
    );
  }
```

- [ ] **Step 6: Run** `npm run lint && npm test` — expect 0 errors / all green. Manual smoke: `npm run tauri dev`, open a project, New session → Claude spawns exactly as before.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tauri.ts src/lib/windowMode.ts src/store/tabsSlice.ts src/components/terminal/TerminalView.tsx src/components/center/TabContent.tsx src/components/center/TabBar.tsx
git commit -m "refactor(desktop): route frontend spawn path through provider-aware agent PtyKind"
```

(Include `TabBar.tsx` only if the `buildSessionWindowUrl` caller lives there.)

---

### Task 4: Activity seam — extract the extractor

**Files:**
- Modify: `src-tauri/src/sessions/activity.rs`
- Test: existing tests must stay green unchanged

- [ ] **Step 1: Refactor (no behavior change).** In `activity.rs`:
  - make the enum visible to the codex module: `pub(crate) enum LastEvent { … }` and make `read_tail_lines` `pub(crate)`,
  - rename the body of `compute_activity` into a generic core:

```rust
pub fn compute_activity(path: &Path, now_ms: i64) -> SessionActivity {
    compute_activity_with(find_last_significant, path, now_ms)
}

pub(crate) fn compute_activity_with(
    extractor: fn(&[String]) -> Option<LastEvent>,
    path: &Path,
    now_ms: i64,
) -> SessionActivity {
    // …existing body of compute_activity, with the single call site
    // `find_last_significant(&lines)` replaced by `extractor(&lines)`
}
```

  - add the provider dispatch entry point (codex extractor arrives in Task 7; reference it now so Task 7 just fills the function in — until then point both arms at the claude extractor with a `// codex extractor lands in sessions::codex::activity` swap in Task 7):

```rust
use crate::domain::Provider;

pub fn compute_activity_for(provider: Provider, path: &Path, now_ms: i64) -> SessionActivity {
    match provider {
        Provider::Claude => compute_activity_with(find_last_significant, path, now_ms),
        Provider::Codex => compute_activity_with(find_last_significant, path, now_ms),
    }
}
```

- [ ] **Step 2: Run** `cargo test sessions::activity` — expect PASS, all existing tests unchanged.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sessions/activity.rs
git commit -m "refactor(desktop): extract activity extractor seam for per-provider dispatch"
```

---

### Task 5: Codex session discovery (reader + meta cache + zst)

**Files:**
- Create: `src-tauri/src/sessions/codex/mod.rs`, `src-tauri/src/sessions/codex/reader.rs`
- Modify: `src-tauri/src/sessions/mod.rs` (add `pub mod codex;`), `src-tauri/Cargo.toml` (add `zstd = "0.13"`)
- Test: inline `#[cfg(test)]` in `reader.rs`

- [ ] **Step 1: Write the failing tests.** Create `src-tauri/src/sessions/codex/reader.rs` with the test module below plus minimal stubs (`scan_sessions` returning `vec![]`, `find_session` returning `None`, `list_for_cwd` returning `vec![]`) so it compiles and the tests FAIL:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn meta_line(id: &str, cwd: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-06-11T10:00:00.000Z","type":"session_meta","payload":{{"id":"{id}","timestamp":"2026-06-11T10:00:00.000Z","cwd":"{cwd}","originator":"codex_cli_rs","cli_version":"0.139.0"}}}}"#
        )
    }

    fn write_rollout(root: &std::path::Path, day: &str, name: &str, content: &str) -> std::path::PathBuf {
        let dir = root.join("2026").join("06").join(day);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn scan_finds_sessions_across_days() {
        let td = TempDir::new().unwrap();
        write_rollout(td.path(), "10", "rollout-2026-06-10T09-00-00-aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
            &meta_line("aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/proj/x"));
        write_rollout(td.path(), "11", "rollout-2026-06-11T09-00-00-bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl",
            &meta_line("bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "/proj/y"));
        let all = scan_sessions(td.path());
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|s| s.session_id == "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa" && s.cwd == "/proj/x"));
    }

    #[test]
    fn scan_skips_files_without_session_meta() {
        let td = TempDir::new().unwrap();
        write_rollout(td.path(), "11", "rollout-x.jsonl", r#"{"type":"event_msg","payload":{}}"#);
        assert!(scan_sessions(td.path()).is_empty());
    }

    #[test]
    fn missing_root_yields_empty() {
        assert!(scan_sessions(std::path::Path::new("/nonexistent-codex-root")).is_empty());
    }

    #[test]
    fn find_session_locates_file_by_id() {
        let td = TempDir::new().unwrap();
        let p = write_rollout(td.path(), "11", "rollout-cccc.jsonl", &meta_line("cccc3333-cccc-cccc-cccc-cccccccccccc", "/p"));
        assert_eq!(find_session(td.path(), "cccc3333-cccc-cccc-cccc-cccccccccccc"), Some(p));
        assert_eq!(find_session(td.path(), "nope"), None);
    }

    #[test]
    fn list_for_cwd_filters_and_builds_meta() {
        let td = TempDir::new().unwrap();
        let content = format!(
            "{}\n{}\n",
            meta_line("dddd4444-dddd-dddd-dddd-dddddddddddd", "/proj/match"),
            r#"{"timestamp":"2026-06-11T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the login bug"}]}}"#,
        );
        write_rollout(td.path(), "11", "rollout-dddd.jsonl", &content);
        write_rollout(td.path(), "11", "rollout-eeee.jsonl", &meta_line("eeee5555-eeee-eeee-eeee-eeeeeeeeeeee", "/proj/other"));

        let list = list_for_cwd(td.path(), "/proj/match", 7, 50);
        assert_eq!(list.len(), 1);
        let m = &list[0];
        assert_eq!(m.id, "dddd4444-dddd-dddd-dddd-dddddddddddd");
        assert_eq!(m.project_id, 7);
        assert_eq!(m.provider, crate::domain::Provider::Codex);
        assert_eq!(m.title, "fix the login bug");
        assert_eq!(m.cwd.as_deref(), Some("/proj/match"));
    }

    #[test]
    fn reads_zst_compressed_rollout() {
        let td = TempDir::new().unwrap();
        let raw = meta_line("ffff6666-ffff-ffff-ffff-ffffffffffff", "/proj/z");
        let compressed = zstd::stream::encode_all(raw.as_bytes(), 0).unwrap();
        let dir = td.path().join("2026").join("06").join("11");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("rollout-ffff.jsonl.zst"), compressed).unwrap();
        let all = scan_sessions(td.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].cwd, "/proj/z");
    }
}
```

- [ ] **Step 2: Run** `cargo test sessions::codex` — expect FAIL (functions missing / module missing).

- [ ] **Step 3: Implement** `src-tauri/src/sessions/codex/reader.rs`:

```rust
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use parking_lot::Mutex;
use serde_json::Value;
use crate::domain::{Provider, SessionMeta};
use crate::error::{AppError, AppResult};

const META_SCAN_LIMIT: usize = 100;

pub fn codex_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".codex").join("sessions"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Opens a rollout for line reading, transparently decompressing `.zst`.
pub(crate) fn open_lines(path: &Path) -> AppResult<Box<dyn BufRead>> {
    let file = fs::File::open(path)?;
    if path.extension().map(|e| e == "zst").unwrap_or(false) {
        let dec = zstd::stream::read::Decoder::new(file)
            .map_err(|e| AppError::Other(format!("zstd: {e}")))?;
        Ok(Box::new(BufReader::new(dec)))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

pub struct CodexSessionFile {
    pub path: PathBuf,
    pub session_id: String,
    pub cwd: String,
    pub git_branch: Option<String>,
    pub modified_ms: i64,
}

#[derive(Clone)]
struct CachedMeta {
    mtime_ms: i64,
    session_id: String,
    cwd: String,
    git_branch: Option<String>,
}

fn meta_cache() -> &'static Mutex<HashMap<PathBuf, CachedMeta>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedMeta>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_file_meta(path: &Path) -> Option<CodexSessionFile> {
    let mtime = mtime_ms(path);
    if let Some(hit) = meta_cache().lock().get(path) {
        if hit.mtime_ms == mtime {
            return Some(CodexSessionFile {
                path: path.to_path_buf(),
                session_id: hit.session_id.clone(),
                cwd: hit.cwd.clone(),
                git_branch: hit.git_branch.clone(),
                modified_ms: mtime,
            });
        }
    }
    let mut reader = open_lines(path).ok()?;
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let v: Value = serde_json::from_str(&first).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = v.get("payload")?;
    let session_id = payload.get("id").and_then(|x| x.as_str())?.to_string();
    let cwd = payload.get("cwd").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let git_branch = payload
        .get("git")
        .and_then(|g| g.get("branch"))
        .and_then(|b| b.as_str())
        .map(String::from);
    meta_cache().lock().insert(path.to_path_buf(), CachedMeta {
        mtime_ms: mtime,
        session_id: session_id.clone(),
        cwd: cwd.clone(),
        git_branch: git_branch.clone(),
    });
    Some(CodexSessionFile { path: path.to_path_buf(), session_id, cwd, git_branch, modified_ms: mtime })
}

fn is_rollout_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    name.starts_with("rollout-") && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
}

/// Walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)`, newest first.
pub fn scan_sessions(root: &Path) -> Vec<CodexSessionFile> {
    fn subdirs_desc(dir: &Path) -> Vec<PathBuf> {
        let Ok(rd) = fs::read_dir(dir) else { return vec![] };
        let mut out: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        out.sort();
        out.reverse();
        out
    }
    let mut out = Vec::new();
    for year in subdirs_desc(root) {
        for month in subdirs_desc(&year) {
            for day in subdirs_desc(&month) {
                let Ok(files) = fs::read_dir(&day) else { continue };
                for f in files.filter_map(|e| e.ok()) {
                    let p = f.path();
                    if is_rollout_file(&p) {
                        if let Some(meta) = session_file_meta(&p) {
                            out.push(meta);
                        }
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

pub fn find_session(root: &Path, session_id: &str) -> Option<PathBuf> {
    scan_sessions(root).into_iter().find(|s| s.session_id == session_id).map(|s| s.path)
}

pub(crate) fn is_meta_codex_text(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<user_instructions>")
        || t.starts_with("<environment_context>")
        || t.starts_with("<ENVIRONMENT_CONTEXT>")
        || t.starts_with("<turn_context>")
}

fn first_user_text(path: &Path) -> Option<String> {
    let reader = open_lines(path).ok()?;
    for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
        if i >= META_SCAN_LIMIT { break; }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("response_item") { continue; }
        let Some(p) = v.get("payload") else { continue };
        if p.get("type").and_then(|t| t.as_str()) != Some("message") { continue; }
        if p.get("role").and_then(|r| r.as_str()) != Some("user") { continue; }
        let Some(arr) = p.get("content").and_then(|c| c.as_array()) else { continue };
        for item in arr {
            if item.get("type").and_then(|t| t.as_str()) != Some("input_text") { continue; }
            let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
            if !text.is_empty() && !is_meta_codex_text(text) {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= max { trimmed }
    else { let mut t: String = trimmed.chars().take(max).collect(); t.push('…'); t }
}

pub fn list_for_cwd(root: &Path, cwd: &str, project_id: i64, limit: usize) -> Vec<SessionMeta> {
    scan_sessions(root)
        .into_iter()
        .filter(|s| s.cwd == cwd)
        .take(limit)
        .map(|s| {
            let title = first_user_text(&s.path)
                .map(|t| truncate(&t, 80))
                .unwrap_or_else(|| format!("Sesja {}", &s.session_id[..8.min(s.session_id.len())]));
            let approx_messages = (s.path.metadata().map(|m| m.len()).unwrap_or(0) / 500).max(1) as usize;
            SessionMeta {
                id: s.session_id.clone(),
                project_id,
                title,
                message_count: approx_messages,
                last_modified: s.modified_ms,
                git_branch: s.git_branch.clone(),
                cwd: Some(s.cwd.clone()),
                activity: crate::sessions::activity::compute_activity_for(Provider::Codex, &s.path, now_ms()),
                provider: Provider::Codex,
            }
        })
        .collect()
}

pub fn count_for_cwd(root: &Path, cwd: &str) -> usize {
    scan_sessions(root).into_iter().filter(|s| s.cwd == cwd).count()
}

pub fn first_user_prompt(path: &Path) -> AppResult<Option<String>> {
    Ok(first_user_text(path))
}
```

Create `src-tauri/src/sessions/codex/mod.rs`:

```rust
pub mod activity;
pub mod parser;
pub mod reader;
```

(Stub `activity.rs` and `parser.rs` as empty files for now — they are filled in Tasks 6–7. If the compiler complains about empty modules, leave them out of `mod.rs` until their tasks and add `pub mod reader;` only.)

Add to `src-tauri/src/sessions/mod.rs`: `pub mod codex;`. Add to `src-tauri/Cargo.toml` under `[dependencies]`: `zstd = "0.13"`.

- [ ] **Step 4: Run** `cargo test sessions::codex` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(desktop): codex rollout discovery with meta cache and zst support"
```

---

### Task 6: Codex rollout parser → `HistoryBlock`

**Files:**
- Create: `src-tauri/src/sessions/codex/parser.rs`
- Create (if Task 0 not yet done): `src-tauri/tests/fixtures/codex-rollout.jsonl` with the synthetic content below — replace with the real capture when Task 0 lands
- Modify: `src-tauri/src/sessions/parser.rs` (make `summarize_input` `pub(crate)`)

Synthetic fixture (one JSON object per line):

```jsonl
{"timestamp":"2026-06-11T10:00:00.000Z","type":"session_meta","payload":{"id":"0196f7a1-aaaa-bbbb-cccc-123456789abc","timestamp":"2026-06-11T10:00:00.000Z","cwd":"/home/user/proj","originator":"codex_cli_rs","cli_version":"0.139.0"}}
{"timestamp":"2026-06-11T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<user_instructions>repo rules</user_instructions>"}]}}
{"timestamp":"2026-06-11T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}
{"timestamp":"2026-06-11T10:00:03.000Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Thinking about it"}],"content":null}}
{"timestamp":"2026-06-11T10:00:04.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"ls\"]}","call_id":"call_1"}}
{"timestamp":"2026-06-11T10:00:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"{\"output\":\"file.txt\\n\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.1}}"}}
{"timestamp":"2026-06-11T10:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}
{"timestamp":"2026-06-11T10:00:07.000Z","type":"event_msg","payload":{"type":"token_count"}}
```

- [ ] **Step 1: Write the failing tests** in `parser.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::HistoryBlock;

    fn lines() -> Vec<String> {
        let s = include_str!("../../../tests/fixtures/codex-rollout.jsonl");
        s.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect()
    }

    #[test]
    fn skips_session_meta_and_event_msg() {
        assert!(parse_codex_line(0, &lines()[0]).unwrap().is_empty());
        assert!(parse_codex_line(7, &lines()[7]).unwrap().is_empty());
    }

    #[test]
    fn skips_meta_user_instructions() {
        assert!(parse_codex_line(1, &lines()[1]).unwrap().is_empty());
    }

    #[test]
    fn parses_user_text_with_stable_uuid() {
        let blocks = parse_codex_line(2, &lines()[2]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::UserText { text, uuid, .. } if text == "Hello" && uuid == "cx-2"));
    }

    #[test]
    fn parses_reasoning_as_thinking() {
        let blocks = parse_codex_line(3, &lines()[3]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::AssistantThinking { text, .. } if text == "Thinking about it"));
    }

    #[test]
    fn parses_function_call_as_tool_use() {
        let blocks = parse_codex_line(4, &lines()[4]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::ToolUse { name, .. } if name == "shell"));
    }

    #[test]
    fn parses_function_call_output_as_tool_result() {
        let blocks = parse_codex_line(5, &lines()[5]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::ToolResult { content, is_error: false, .. } if content.contains("file.txt")));
    }

    #[test]
    fn parses_assistant_text() {
        let blocks = parse_codex_line(6, &lines()[6]).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::AssistantText { text, .. } if text == "Done."));
    }

    #[test]
    fn nonzero_exit_code_marks_error() {
        let line = r#"{"timestamp":"2026-06-11T10:00:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":"{\"output\":\"boom\",\"metadata\":{\"exit_code\":1}}"}}"#;
        let blocks = parse_codex_line(0, line).unwrap();
        assert!(matches!(&blocks[0], HistoryBlock::ToolResult { is_error: true, .. }));
    }
}
```

- [ ] **Step 2: Run** `cargo test sessions::codex::parser` — expect FAIL.

- [ ] **Step 3: Implement** `parser.rs`:

```rust
use serde_json::Value;
use crate::domain::HistoryBlock;
use super::reader::is_meta_codex_text;

fn ts_ms(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

/// Parses one rollout line into zero or more `HistoryBlock`s. Codex response
/// items carry no per-item uuid, so blocks get a stable synthetic `cx-<line_no>`
/// id (rollouts are append-only, so line numbers never shift).
pub fn parse_codex_line(line_no: usize, line: &str) -> Result<Vec<HistoryBlock>, serde_json::Error> {
    let v: Value = serde_json::from_str(line)?;
    if v.get("type").and_then(|t| t.as_str()) != Some("response_item") {
        return Ok(vec![]);
    }
    let ts = ts_ms(v.get("timestamp"));
    let uuid = format!("cx-{line_no}");
    let Some(p) = v.get("payload") else { return Ok(vec![]) };
    let item_type = p.get("type").and_then(|t| t.as_str()).unwrap_or("");

    Ok(match item_type {
        "message" => parse_message(p, &uuid, ts),
        "reasoning" => parse_reasoning(p, &uuid, ts),
        "function_call" | "custom_tool_call" => parse_tool_call(p, &uuid, ts),
        "local_shell_call" => parse_local_shell_call(p, &uuid, ts),
        "function_call_output" | "custom_tool_call_output" => parse_tool_output(p, &uuid, ts),
        _ => vec![],
    })
}

fn parse_message(p: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let role = p.get("role").and_then(|r| r.as_str()).unwrap_or("");
    let Some(arr) = p.get("content").and_then(|c| c.as_array()) else { return vec![] };
    let mut out = Vec::new();
    for item in arr {
        let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("");
        if text.is_empty() { continue; }
        match role {
            "user" => {
                if !is_meta_codex_text(text) {
                    out.push(HistoryBlock::UserText { uuid: uuid.into(), timestamp: ts, text: text.to_string() });
                }
            }
            "assistant" => out.push(HistoryBlock::AssistantText { uuid: uuid.into(), timestamp: ts, text: text.to_string() }),
            _ => {}
        }
    }
    out
}

fn parse_reasoning(p: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(arr) = p.get("summary").and_then(|s| s.as_array()) else { return vec![] };
    let text: String = arr.iter()
        .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() { return vec![] }
    vec![HistoryBlock::AssistantThinking { uuid: uuid.into(), timestamp: ts, text }]
}

fn parse_tool_call(p: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let name = p.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
    let raw_input = p.get("arguments")
        .or_else(|| p.get("input"))
        .map(|a| match a {
            Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::String(s.clone())),
            other => other.clone(),
        })
        .unwrap_or(Value::Null);
    let input_summary = crate::sessions::parser::summarize_input(&raw_input);
    vec![HistoryBlock::ToolUse { uuid: uuid.into(), timestamp: ts, name, input_summary, raw_input }]
}

fn parse_local_shell_call(p: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let raw_input = p.get("action").cloned().unwrap_or(Value::Null);
    let input_summary = crate::sessions::parser::summarize_input(&raw_input);
    vec![HistoryBlock::ToolUse { uuid: uuid.into(), timestamp: ts, name: "shell".into(), input_summary, raw_input }]
}

fn parse_tool_output(p: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let raw = p.get("output");
    let (content, is_error) = match raw {
        // function_call_output.output is often a JSON-encoded string:
        // {"output":"...","metadata":{"exit_code":0}}
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(inner) => {
                let text = inner.get("output").and_then(|o| o.as_str()).unwrap_or(s).to_string();
                let exit = inner.get("metadata").and_then(|m| m.get("exit_code")).and_then(|c| c.as_i64()).unwrap_or(0);
                (text, exit != 0)
            }
            Err(_) => (s.clone(), false),
        },
        Some(other) => (other.to_string(), false),
        None => (String::new(), false),
    };
    vec![HistoryBlock::ToolResult { uuid: uuid.into(), timestamp: ts, content, is_error }]
}
```

In `src-tauri/src/sessions/parser.rs` change `fn summarize_input` to `pub(crate) fn summarize_input`. Ensure `sessions/codex/mod.rs` declares `pub mod parser;`.

- [ ] **Step 4: Run** `cargo test sessions::codex` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions src-tauri/tests/fixtures/codex-rollout.jsonl
git commit -m "feat(desktop): parse codex rollout response items into HistoryBlocks"
```

---

### Task 7: Codex activity extractor

**Files:**
- Create: `src-tauri/src/sessions/codex/activity.rs`
- Modify: `src-tauri/src/sessions/activity.rs` (point the Codex arm at it)

- [ ] **Step 1: Write the failing tests** in `codex/activity.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::activity::LastEvent;

    fn last(lines: &[&str]) -> Option<LastEvent> {
        let owned: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        find_last_significant_codex(&owned)
    }

    #[test]
    fn user_message_means_running() {
        let lines = [r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do it"}]}}"#];
        assert_eq!(last(&lines), Some(LastEvent::UserText));
    }

    #[test]
    fn meta_user_message_skipped() {
        let lines = [
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
        ];
        assert_eq!(last(&lines), Some(LastEvent::AssistantText));
    }

    #[test]
    fn unresolved_function_call() {
        let lines = [r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}"#];
        assert_eq!(last(&lines), Some(LastEvent::AssistantToolUseUnresolved));
    }

    #[test]
    fn resolved_output_is_tool_result() {
        let lines = [
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}","call_id":"c1"}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\"output\":\"ok\",\"metadata\":{\"exit_code\":0}}"}}"#,
        ];
        assert_eq!(last(&lines), Some(LastEvent::UserToolResult { is_error: false }));
    }

    #[test]
    fn failed_output_is_error_result() {
        let lines = [r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\"output\":\"boom\",\"metadata\":{\"exit_code\":2}}"}}"#];
        assert_eq!(last(&lines), Some(LastEvent::UserToolResult { is_error: true }));
    }

    #[test]
    fn empty_is_none() {
        assert_eq!(last(&[]), None);
    }
}
```

- [ ] **Step 2: Run** `cargo test sessions::codex::activity` — expect FAIL.

- [ ] **Step 3: Implement** `codex/activity.rs`:

```rust
use serde_json::Value;
use crate::sessions::activity::LastEvent;
use super::reader::is_meta_codex_text;

fn payload<'a>(v: &'a Value) -> Option<&'a Value> {
    if v.get("type").and_then(|t| t.as_str()) != Some("response_item") { return None; }
    v.get("payload")
}

fn output_exit_error(p: &Value) -> bool {
    match p.get("output") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s)
            .ok()
            .and_then(|inner| inner.get("metadata").and_then(|m| m.get("exit_code")).and_then(|c| c.as_i64()))
            .map(|code| code != 0)
            .unwrap_or(false),
        _ => false,
    }
}

pub(crate) fn find_last_significant_codex(lines: &[String]) -> Option<LastEvent> {
    let mut resolved_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = payload(&v) else { continue };
        if matches!(p.get("type").and_then(|t| t.as_str()), Some("function_call_output") | Some("custom_tool_call_output")) {
            if let Some(id) = p.get("call_id").and_then(|s| s.as_str()) {
                resolved_ids.insert(id.to_string());
            }
        }
    }

    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = payload(&v) else { continue };
        match p.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "message" => {
                let role = p.get("role").and_then(|r| r.as_str()).unwrap_or("");
                let Some(arr) = p.get("content").and_then(|c| c.as_array()) else { continue };
                let has_real_text = arr.iter().any(|i| {
                    let text = i.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    !text.is_empty() && (role != "user" || !is_meta_codex_text(text))
                });
                if !has_real_text { continue; }
                return Some(match role {
                    "user" => LastEvent::UserText,
                    _ => LastEvent::AssistantText,
                });
            }
            "function_call" | "custom_tool_call" | "local_shell_call" => {
                let id = p.get("call_id").and_then(|s| s.as_str()).unwrap_or("");
                if resolved_ids.contains(id) {
                    return Some(LastEvent::AssistantToolUseResolved);
                }
                return Some(LastEvent::AssistantToolUseUnresolved);
            }
            "function_call_output" | "custom_tool_call_output" => {
                return Some(LastEvent::UserToolResult { is_error: output_exit_error(p) });
            }
            _ => continue,
        }
    }
    None
}
```

In `src-tauri/src/sessions/activity.rs` point the Codex arm of `compute_activity_for` at it:

```rust
        Provider::Codex => compute_activity_with(
            crate::sessions::codex::activity::find_last_significant_codex,
            path,
            now_ms,
        ),
```

- [ ] **Step 4: Run** `cargo test sessions` — expect PASS (claude activity tests untouched).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sessions
git commit -m "feat(desktop): codex activity detection over rollout tails"
```

---

### Task 8: Command-level dispatch — merged list, history, count, watch, titles

**Files:**
- Create: `src-tauri/src/sessions/codex/reader.rs` → add `read_history` (same file as Task 5)
- Modify: `src-tauri/src/commands/sessions.rs`, `src-tauri/src/sessions/watcher.rs`, `src/lib/tauri.ts`
- Test: inline tests in `commands/sessions.rs` + `codex/reader.rs`

- [ ] **Step 1: Write the failing tests.** In `commands/sessions.rs` add a pure merge helper test:

```rust
#[cfg(test)]
mod merge_tests {
    use super::*;
    use crate::domain::{Provider, SessionActivity, SessionMeta};

    fn meta(id: &str, provider: Provider, last_modified: i64) -> SessionMeta {
        SessionMeta {
            id: id.into(), project_id: 1, title: id.into(), message_count: 1,
            last_modified, git_branch: None, cwd: None,
            activity: SessionActivity::Idle, provider,
        }
    }

    #[test]
    fn merge_interleaves_by_mtime_desc_with_offset() {
        let claude = vec![meta("c1", Provider::Claude, 300), meta("c2", Provider::Claude, 100)];
        let codex = vec![meta("x1", Provider::Codex, 200)];
        let merged = merge_session_lists(claude.clone(), codex.clone(), 10, 0);
        let ids: Vec<&str> = merged.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["c1", "x1", "c2"]);

        let page2 = merge_session_lists(claude, codex, 2, 1);
        let ids2: Vec<&str> = page2.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids2, vec!["x1", "c2"]);
    }
}
```

In `codex/reader.rs` tests add:

```rust
    #[test]
    fn read_history_paginates_with_stable_uuids() {
        let td = TempDir::new().unwrap();
        let content = format!(
            "{}\n{}\n{}\n",
            meta_line("abab1212-abab-abab-abab-abababababab", "/p"),
            r#"{"timestamp":"2026-06-11T10:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"one"}]}}"#,
            r#"{"timestamp":"2026-06-11T10:00:06.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"two"}]}}"#,
        );
        write_rollout(td.path(), "11", "rollout-abab.jsonl", &content);

        let h = read_history(td.path(), 1, "abab1212-abab-abab-abab-abababababab", Some(1), None).unwrap();
        assert_eq!(h.blocks.len(), 1);
        assert!(h.has_more_before);
        assert_eq!(h.meta.provider, crate::domain::Provider::Codex);

        let older = read_history(td.path(), 1, "abab1212-abab-abab-abab-abababababab", Some(1), Some("cx-2")).unwrap();
        assert_eq!(older.blocks.len(), 1);
    }
```

- [ ] **Step 2: Run** `cargo test merge_tests sessions::codex` — expect FAIL.

- [ ] **Step 3: Implement.**

**(a)** `codex/reader.rs` — append:

```rust
use crate::domain::SessionHistory;

pub fn read_history(
    root: &Path,
    project_id: i64,
    session_id: &str,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> AppResult<SessionHistory> {
    crate::validation::validate_session_id(session_id)?;
    let path = find_session(root, session_id)
        .ok_or_else(|| AppError::NotFound(session_id.to_string()))?;
    let limit = limit.unwrap_or(200).min(500);

    let mut all_blocks = Vec::new();
    let mut title: Option<String> = None;
    let mut line_count = 0usize;
    let reader = open_lines(&path)?;
    for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
        if line.trim().is_empty() { continue; }
        line_count += 1;
        if let Ok(bs) = super::parser::parse_codex_line(i, &line) {
            if title.is_none() {
                if let Some(crate::domain::HistoryBlock::UserText { text, .. }) = bs.first() {
                    title = Some(truncate(text, 80));
                }
            }
            all_blocks.extend(bs);
        }
    }

    let end = match before_uuid {
        Some(before) => all_blocks.iter().position(|b| block_uuid(b) == before).unwrap_or(all_blocks.len()),
        None => all_blocks.len(),
    };
    let start = end.saturating_sub(limit);
    let blocks = all_blocks[start..end].to_vec();
    let has_more_before = start > 0;

    let file_meta = session_file_meta(&path).ok_or_else(|| AppError::NotFound(session_id.to_string()))?;
    let meta = SessionMeta {
        id: session_id.to_string(),
        project_id,
        title: title.unwrap_or_else(|| format!("Sesja {}", &session_id[..8.min(session_id.len())])),
        message_count: line_count,
        last_modified: file_meta.modified_ms,
        git_branch: file_meta.git_branch,
        cwd: Some(file_meta.cwd),
        activity: crate::sessions::activity::compute_activity_for(Provider::Codex, &path, now_ms()),
        provider: Provider::Codex,
    };
    Ok(SessionHistory { meta, blocks, has_more_before })
}

fn block_uuid(b: &crate::domain::HistoryBlock) -> &str {
    use crate::domain::HistoryBlock::*;
    match b {
        UserText { uuid, .. } | AssistantText { uuid, .. } | AssistantThinking { uuid, .. }
        | ToolUse { uuid, .. } | ToolResult { uuid, .. } | Attachment { uuid, .. } | System { uuid, .. } => uuid,
    }
}
```

**(b)** `commands/sessions.rs` — add imports (`use crate::domain::Provider;`, `use crate::sessions::codex;`), the root helper, the pure merge, and dispatch:

```rust
fn codex_root() -> AppResult<PathBuf> {
    crate::sessions::codex::reader::codex_root()
}

fn merge_session_lists(
    claude: Vec<SessionMeta>,
    codex: Vec<SessionMeta>,
    limit: usize,
    offset: usize,
) -> Vec<SessionMeta> {
    let mut all: Vec<SessionMeta> = claude.into_iter().chain(codex).collect();
    all.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    all.into_iter().skip(offset).take(limit).collect()
}
```

Rework `list_sessions`: fetch a `offset + limit` window from each side, merge, then overlay DB titles (titles repo is keyed by session id, so it works for both providers):

```rust
#[tauri::command]
pub fn list_sessions(
    state: State<AppState>,
    project_id: i64,
    limit: usize,
    offset: usize,
) -> AppResult<Vec<SessionMeta>> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = session_dir(&proj)?;
    let window = offset + limit;
    let claude = catch(move || reader::list_sessions(project_id, &dir, window, 0))?;
    let codex_dir = codex_root()?;
    let proj_path = proj.path.clone();
    let codex = catch(move || Ok(codex::reader::list_for_cwd(&codex_dir, &proj_path, project_id, window)))?;
    let mut sessions = merge_session_lists(claude, codex, limit, offset);
    let titles = session_titles_repo::get_all(&c, project_id);
    for s in &mut sessions {
        if let Some(t) = titles.get(&s.id) {
            s.title = t.clone();
        }
    }
    Ok(sessions)
}
```

Add `provider: Option<Provider>` (default Claude) to `read_session_history`, `open_session_watch`, `export_session`, `generate_session_title`; dispatch:

```rust
#[tauri::command]
pub fn read_session_history(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    provider: Option<Provider>,
    limit: Option<usize>,
    before_uuid: Option<String>,
) -> AppResult<SessionHistory> { … }
```

(The signature keeps all existing params; only `provider` is new. In the body:)

```rust
    match provider.unwrap_or(Provider::Claude) {
        Provider::Claude => { /* existing body */ }
        Provider::Codex => {
            let root = codex_root()?;
            let sid = session_id.clone();
            let mut history = catch(move || codex::reader::read_history(&root, project_id, &sid, limit, before_uuid.as_deref()))?;
            if let Some(t) = session_titles_repo::get(&c, project_id, &session_id) {
                history.meta.title = t;
            }
            Ok(history)
        }
    }
```

`open_session_watch` Codex arm resolves the path via `codex::reader::find_session(&codex_root()?, &session_id)` (NotFound if absent) and calls `state.session_watchers.open(app, &session_id, path, Provider::Codex)`. Claude arm passes `Provider::Claude`.

`count_sessions` adds the codex count:

```rust
    let codex_count = codex::reader::count_for_cwd(&codex_root()?, &proj.path);
    Ok(count + codex_count)
```

`generate_session_title` + `export_session`: resolve `first_user_prompt`/history via the provider (Codex: `codex::reader::first_user_prompt(&path)` / `codex::reader::read_history(…)`); the `claude -p` invocation itself stays unchanged.

**(c)** `sessions/watcher.rs`: `OpenSession` gains `provider: Provider` and `lines_seen: usize` (count non-empty lines at `open` time). `open(…)` gains a `provider: Provider` parameter (update the one existing call site in commands plus the codex one). On appended lines dispatch:

```rust
let blocks = match session.provider {
    Provider::Claude => parse_line(&line).unwrap_or_default(),
    Provider::Codex => crate::sessions::codex::parser::parse_codex_line(session.lines_seen, &line).unwrap_or_default(),
};
session.lines_seen += 1;
```

Feed `UsageAccumulator` only when `provider == Provider::Claude` (both the initial scan and appends). Replace `compute_activity(path, now)` calls with `compute_activity_for(session.provider, path, now)`.

**(d)** `src/lib/tauri.ts` — pass provider through (default `'claude'` keeps old callers working):

```ts
  readSessionHistory: (projectId: number, sessionId: string, provider: Provider = 'claude', limit?: number, beforeUuid?: string) =>
    invoke<SessionHistory>('read_session_history', { projectId, sessionId, provider, limit, beforeUuid }),
  openSessionWatch: (projectId: number, sessionId: string, provider: Provider = 'claude') =>
    invoke<void>('open_session_watch', { projectId, sessionId, provider }),
```

Update `exportSession` / `generateSessionTitle` wrappers the same way. Update their call sites (`grep -rn "readSessionHistory\|openSessionWatch\|exportSession\|generateSessionTitle" src/`) to pass `provider` where a `SessionMeta`/tab is in scope (HistoryView gets a `provider` prop from `TabContent`: `provider={tab.provider ?? 'claude'}`).

- [ ] **Step 4: Run** `cd src-tauri && cargo test && cd .. && npm run lint && npm test` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/src src/lib src/components
git commit -m "feat(desktop): merged session list and provider-dispatched history, watch and titles"
```

---

### Task 9: Provider-aware session opening + `new-` linking

**Files:**
- Modify: `src/store/tabsSlice.ts` (`openSessionTab` signature), `src/components/sidebar/SessionList.tsx:21`, `src/store/sessionsSlice.ts:142-153` (linking), `src/store/index.ts` (`PersistedTab`)
- Test: existing vitest suite + `npm run lint`

- [ ] **Step 1: `openSessionTab` carries provider.** In `tabsSlice.ts`:

```ts
  openSessionTab: (projectId: number, sessionId: string, title: string, provider?: Provider) => void;
```

and in the implementation include `...(provider ? { provider } : {})` in the created tab object. `SessionList.tsx` passes it:

```tsx
        <SessionItem key={s.id} session={s} onClick={() => openTab(projectId, s.id, s.title, s.provider)} />
```

- [ ] **Step 2: Provider-aware `new-` linking.** In `sessionsSlice.ts` replace the index-paired loop (lines ~148-153) with provider matching:

```ts
    if (unlinkedNewTabs.length > 0 && newSessions.length > 0) {
      const pool = [...newSessions];
      for (const tab of unlinkedNewTabs) {
        const idx = pool.findIndex(s => s.provider === (tab.provider ?? 'claude'));
        if (idx < 0) continue;
        const [s] = pool.splice(idx, 1);
        linkNewSession(tab.id, s.id);
        renameTab(tab.id, s.title);
      }
    }
```

- [ ] **Step 3: Persist provider on tabs.** In `src/store/index.ts` add `provider?: Provider` to `PersistedTab` (import the type), include it in `writeTabsToLocalStorage`'s map (`...(t.provider ? { provider: t.provider } : {})`), and keep `sanitizeRestoredTabs` as is (unknown values are dropped naturally by the spawn default).

- [ ] **Step 4: Run** `npm run lint && npm test` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store src/components/sidebar/SessionList.tsx
git commit -m "feat(desktop): carry session provider through tabs, linking and persistence"
```

---

### Task 10: `enabledProviders` setting + `detect_providers` + Settings UI

**Files:**
- Create: `src-tauri/src/commands/providers.rs`, `src/lib/providers.ts`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (register), `src-tauri/src/commands/models.rs:80-99` (generalize), `src/store/settingsSlice.ts`, `src/store/index.ts`, `src/lib/tauri.ts`, `src/components/dialogs/SettingsDialog.tsx`, `src/types/index.ts`

- [ ] **Step 1: Backend detection.** In `commands/models.rs` generalize the locator (keep `locate_claude` calling it):

```rust
pub(crate) fn locate_binary(state: &AppState, name: &str) -> Option<PathBuf> {
    let path_var = state
        .db
        .get()
        .ok()
        .map(|conn| resolve_shell(&conn))
        .map(|shell| ensure_shell_env(state, &shell))
        .and_then(|env| env.get("PATH").cloned())
        .or_else(|| std::env::var("PATH").ok())?;
    for dir in path_var.split(':') {
        if dir.is_empty() { continue; }
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
        }
    }
    None
}

fn locate_claude(state: &AppState) -> Option<PathBuf> {
    locate_binary(state, "claude")
}
```

Create `commands/providers.rs`:

```rust
use serde::Serialize;
use tauri::State;
use ts_rs::TS;
use crate::domain::Provider;
use crate::state::AppState;

#[derive(Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: Provider,
    pub available: bool,
}

#[tauri::command]
pub fn detect_providers(state: State<AppState>) -> Vec<ProviderInfo> {
    [Provider::Claude, Provider::Codex]
        .into_iter()
        .map(|p| ProviderInfo {
            provider: p,
            available: crate::commands::models::locate_binary(&state, p.id()).is_some(),
        })
        .collect()
}
```

Add `pub mod providers;` to `commands/mod.rs` and register `commands::providers::detect_providers` in the `lib.rs` handler list. Run `cargo test` (regenerates `ProviderInfo.ts`); re-export it from `src/types/index.ts`. Add the wrapper in `src/lib/tauri.ts`:

```ts
  detectProviders: () => invoke<ProviderInfo[]>('detect_providers'),
```

- [ ] **Step 2: Settings state.** In `src/store/settingsSlice.ts` add to the type:

```ts
  enabledProviders: Provider[];
  toggleProvider: (p: Provider) => void;
```

and to the creator:

```ts
  enabledProviders: ['claude'],
  toggleProvider: (p) => {
    const cur = get().enabledProviders;
    const next = cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p];
    if (next.length === 0) return;
    set({ enabledProviders: next });
  },
```

- [ ] **Step 3: Persistence.** In `src/store/index.ts`: add `enabledProviders?: Provider[];` to `Persisted`, `'enabledProviders'` to `PERSISTED_KEYS`, `enabledProviders: state.enabledProviders` to `pickPersistedFields`, add the key to the JSON cases of both `serializeValue` and `deserializeValue` (next to `customModels`), and in `applyPersistedToState`:

```ts
  if (Array.isArray(p.enabledProviders)) {
    const valid = p.enabledProviders.filter((x): x is Provider => x === 'claude' || x === 'codex');
    if (valid.length > 0) patch.enabledProviders = valid;
  }
```

- [ ] **Step 4: Shared provider constants.** Create `src/lib/providers.ts`:

```ts
import type { Provider } from '../types';
import type { IconName } from '../components/shared/Icon';

export const ALL_PROVIDERS: Provider[] = ['claude', 'codex'];

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const PROVIDER_ICON: Record<Provider, IconName> = {
  claude: 'claudeLogo',
  codex: 'openaiLogo',
};
```

- [ ] **Step 5: Settings UI.** In `SettingsDialog.tsx` add a `ProvidersSection` rendered in `GeneralTab` directly above `<NotificationsSection />`:

```tsx
function ProvidersSection() {
  const enabled = useStore(useShallow(s => s.enabledProviders));
  const toggle = useStore(s => s.toggleProvider);
  const [infos, setInfos] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    tauri.detectProviders().then(setInfos).catch(() => setInfos([]));
  }, []);

  return (
    <div>
      <label className="block text-[10px] text-muted uppercase tracking-wider mb-2">
        Dostawcy CLI
      </label>
      <div className="space-y-0.5">
        {ALL_PROVIDERS.map(p => {
          const info = infos.find(i => i.provider === p);
          const isOn = enabled.includes(p);
          const isLastEnabled = isOn && enabled.length === 1;
          return (
            <label key={p} className="flex items-start gap-3 cursor-pointer py-1.5 px-2 hover:bg-bg-elev-2">
              <input
                type="checkbox"
                checked={isOn}
                disabled={isLastEnabled}
                onChange={() => toggle(p)}
                className="accent-accent mt-0.5"
              />
              <div className="flex items-center gap-2">
                <Icon name={PROVIDER_ICON[p]} className="w-3.5 h-3.5" />
                <span className="text-[13px]">{PROVIDER_LABEL[p]}</span>
                {info && !info.available && (
                  <span className="text-[11px] text-warn">nie znaleziono w PATH</span>
                )}
              </div>
            </label>
          );
        })}
      </div>
      <p className="text-[11px] text-muted mt-2">
        Gdy włączony jest więcej niż jeden dostawca, „New session" najpierw pyta, w którym CLI uruchomić sesję.
      </p>
    </div>
  );
}
```

with imports `import { ALL_PROVIDERS, PROVIDER_LABEL, PROVIDER_ICON } from '../../lib/providers';` and `import type { ProviderInfo } from '../../types';`. (The `claudeLogo`/`openaiLogo` icons land in Task 12 — if implementing out of order, temporarily use `'terminal'`.)

- [ ] **Step 6: Run** `cd src-tauri && cargo test && cd .. && npm run lint && npm test` — expect PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src-tauri/src src/store src/lib src/components/dialogs/SettingsDialog.tsx src/types
git commit -m "feat(desktop): enabledProviders setting with CLI detection in settings"
```

---

### Task 11: Provider picker tab

**Files:**
- Create: `src/components/center/ProviderPicker.tsx`, `src/store/tabsSlice.test.ts`
- Modify: `src/store/tabsSlice.ts`, `src/components/center/TabContent.tsx`, `src/components/center/TabBar.tsx` (close guard + rendering)

- [ ] **Step 1: Write the failing tests** — `src/store/tabsSlice.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';

describe('tabsSlice provider picker', () => {
  beforeEach(() => {
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], enabledProviders: ['claude'] });
  });

  it('single provider: New session spawns a fresh claude tab directly', () => {
    useStore.getState().openNewSessionTab(1);
    const tab = useStore.getState().tabs[0];
    expect(tab.kind).toBe('session');
    if (tab.kind !== 'session') return;
    expect(tab.fresh).toBe(true);
    expect(tab.provider).toBe('claude');
    expect(tab.sessionId.startsWith('new-')).toBe(false);
  });

  it('single codex provider: fresh tab uses a new- placeholder id', () => {
    useStore.setState({ enabledProviders: ['codex'] });
    useStore.getState().openNewSessionTab(1);
    const tab = useStore.getState().tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.provider).toBe('codex');
    expect(tab.sessionId.startsWith('new-')).toBe(true);
  });

  it('multiple providers: New session opens a picker tab', () => {
    useStore.setState({ enabledProviders: ['claude', 'codex'] });
    useStore.getState().openNewSessionTab(1);
    const tab = useStore.getState().tabs[0];
    expect(tab.kind).toBe('providerPicker');
    expect(useStore.getState().activeTabId).toBe(tab.id);
  });

  it('chooseProvider replaces the picker with a fresh session tab in place', () => {
    useStore.setState({ enabledProviders: ['claude', 'codex'] });
    useStore.getState().openNewSessionTab(1);
    const pickerId = useStore.getState().tabs[0].id;
    useStore.getState().chooseProvider(pickerId, 'codex');
    const tabs = useStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    if (tab.kind !== 'session') throw new Error('expected session tab');
    expect(tab.provider).toBe('codex');
    expect(tab.fresh).toBe(true);
    expect(useStore.getState().activeTabId).toBe(tab.id);
  });
});
```

- [ ] **Step 2: Run** `npm test -- tabsSlice` — expect FAIL.

- [ ] **Step 3: Implement** in `tabsSlice.ts`:

Add the tab kind:

```ts
  | { kind: 'providerPicker'; id: string; projectId: number; title: string }
```

Change the creator type so it can read settings (mirror `sessionsSlice`'s pattern):

```ts
import type { SettingsSlice } from './settingsSlice';

export const createTabsSlice: StateCreator<TabsSlice & SettingsSlice, [], [], TabsSlice> = (set, get) => ({
```

Add to `TabsSlice` type:

```ts
  startSessionTab: (projectId: number, provider: Provider) => void;
  chooseProvider: (tabId: string, provider: Provider) => void;
```

Implement:

```ts
  openNewSessionTab: (projectId) => {
    const enabled = get().enabledProviders;
    if (enabled.length > 1) {
      const id = `picker:${crypto.randomUUID()}`;
      set({
        tabs: [...get().tabs, { kind: 'providerPicker', id, projectId, title: 'New session' }],
        activeTabId: id,
        mruOrder: moveToFront(get().mruOrder, id),
      });
      return;
    }
    get().startSessionTab(projectId, enabled[0] ?? 'claude');
  },
  startSessionTab: (projectId, provider) => {
    const sessionId = provider === 'claude' ? crypto.randomUUID() : `new-${crypto.randomUUID()}`;
    const id = sessionTabId(sessionId);
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title: 'New session', mode: 'terminal', fresh: true, provider }],
      activeTabId: id,
      mruOrder: moveToFront(get().mruOrder, id),
    });
  },
  chooseProvider: (tabId, provider) => {
    const picker = get().tabs.find(t => t.id === tabId && t.kind === 'providerPicker');
    if (!picker || picker.kind !== 'providerPicker') return;
    const sessionId = provider === 'claude' ? crypto.randomUUID() : `new-${crypto.randomUUID()}`;
    const id = sessionTabId(sessionId);
    set({
      tabs: get().tabs.map(t => t.id === tabId
        ? { kind: 'session' as const, id, projectId: picker.projectId, sessionId, title: 'New session', mode: 'terminal' as const, fresh: true, provider }
        : t),
      activeTabId: id,
      mruOrder: get().mruOrder.map(x => x === tabId ? id : x),
    });
  },
```

Create `src/components/center/ProviderPicker.tsx`:

```tsx
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import { PROVIDER_LABEL, PROVIDER_ICON } from '../../lib/providers';

export function ProviderPicker({ tabId }: { tabId: string }) {
  const enabled = useStore(useShallow(s => s.enabledProviders));
  const choose = useStore(s => s.chooseProvider);

  return (
    <div className="h-full grid place-items-center bg-bg">
      <div className="text-center">
        <div className="text-[13px] text-muted mb-4">Wybierz CLI dla nowej sesji</div>
        <div className="flex gap-3 justify-center">
          {enabled.map(p => (
            <button
              key={p}
              onClick={() => choose(tabId, p)}
              className="flex flex-col items-center gap-2 px-6 py-5 border border-border bg-bg-elev hover:border-accent transition-colors"
            >
              <Icon name={PROVIDER_ICON[p]} className="w-8 h-8" strokeWidth={1.5} />
              <span className="text-[12px] font-medium">{PROVIDER_LABEL[p]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

In `TabContent.tsx` add before the session branches:

```tsx
  if (tab.kind === 'providerPicker') {
    return (
      <div className={`absolute inset-0 ${visible ? '' : 'invisible pointer-events-none'}`}>
        <ProviderPicker tabId={tab.id} />
      </div>
    );
  }
```

In `TabBar.tsx`: ensure `isActiveProcess()` returns `false` for `kind === 'providerPicker'` (a picker has no process — closing must NOT prompt), and that the tab renders with its `title` like other kinds (check the kind-switch in the row renderer; add a `plus` icon case if tabs show per-kind icons).

- [ ] **Step 4: Run** `npm test && npm run lint` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store src/components/center
git commit -m "feat(desktop): provider picker tab for New session with multiple CLIs"
```

---

### Task 12: Provider icons in the session list (status-tinted)

**Files:**
- Modify: `src/components/shared/Icon.tsx`, `src/lib/activity.ts`, `src/components/sidebar/SessionItem.tsx:30-39`
- Test: `src/components/sidebar/SessionItem.test.tsx` (extend existing)

- [ ] **Step 1: Write the failing test** — in `SessionItem.test.tsx` add (mirror the existing render helpers/fixtures in that file; the `SessionMeta` fixtures need the new `provider` field — update them to `provider: 'claude'`):

```tsx
  it('renders the provider icon tinted by activity', () => {
    const session = { ...baseSession, provider: 'codex' as const, activity: 'waitingTool' as const };
    render(<SessionItem session={session} onClick={() => {}} />);
    const icon = screen.getByLabelText('Czeka na zatwierdzenie narzędzia');
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('class') ?? '').toContain('text-warn');
  });
```

- [ ] **Step 2: Run** `npm test -- SessionItem` — expect FAIL.

- [ ] **Step 3: Implement.**

`Icon.tsx` — add two glyphs (simple monochrome stand-ins; swapping in exact brand paths later is a one-line change each):

```tsx
  claudeLogo: <g><path d="M12 3v18"/><path d="M3 12h18"/><path d="M5.6 5.6l12.8 12.8"/><path d="M18.4 5.6L5.6 18.4"/></g>,
  openaiLogo: <polygon points="12 2.5 20.2 7.25 20.2 16.75 12 21.5 3.8 16.75 3.8 7.25"/>,
```

`lib/activity.ts` — add a text-color map and de-Claude the label:

```ts
export const ACTIVITY_TEXT: Record<SessionActivity, string> = {
  running:     'text-success',
  waitingUser: 'text-accent',
  waitingTool: 'text-warn',
  idle:        'text-muted',
};
```

and change `running: 'Aktywna — Claude pracuje'` to `running: 'Aktywna — agent pracuje'`.

`SessionItem.tsx` — replace the dot span (lines 35-38) with the provider icon (keep the attention-bell branch above it untouched):

```tsx
        <span className="shrink-0 inline-flex" title={ACTIVITY_LABEL[session.activity]}>
          <Icon
            name={PROVIDER_ICON[session.provider]}
            className={`w-3 h-3 ${ACTIVITY_TEXT[session.activity]}`}
            strokeWidth={2.5}
            aria-label={ACTIVITY_LABEL[session.activity]}
          />
        </span>
```

with imports updated to `import { ACTIVITY_TEXT, ACTIVITY_LABEL } from '../../lib/activity';` and `import { PROVIDER_ICON } from '../../lib/providers';` (drop the now-unused `ACTIVITY_DOT` import; remove `ACTIVITY_DOT` itself from `lib/activity.ts` if no other usage remains — verify with `grep -rn ACTIVITY_DOT src/`).

Note: `Icon` renders with `aria-hidden="true"`; the spread `{...rest}` places `aria-label` after it, but if the test can't find the element by label, pass `aria-hidden={undefined}` via rest or assert via `container.querySelector('svg')` class list instead — keep whichever assertion style `SessionItem.test.tsx` already uses for the bell icon.

- [ ] **Step 4: Run** `npm test && npm run lint` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components src/lib/activity.ts src/lib/providers.ts
git commit -m "feat(desktop): provider icons with activity tint replace session status dots"
```

---

### Task 13: Full verification + manual QA

- [ ] **Step 1: Full automated pass**

```bash
cd src-tauri && cargo test && cd ..
npm run lint
npm test
```

Expected: zero failures, zero TS errors.

- [ ] **Step 2: Manual QA** (`npm run tauri dev`):

1. Settings → Ogólne → „Dostawcy CLI": both rows visible, Claude checked, availability detected; cannot uncheck the last enabled provider.
2. With only Claude enabled: „New session" spawns Claude directly (no picker) — regression check.
3. Enable Codex → „New session" opens the picker tab; Claude icon spawns a Claude session; Codex icon spawns `codex` in the terminal.
4. Codex session: type a prompt, let it answer; within ~10 s (activity poll) the sidebar shows the new Codex session and the tab links/renames (placeholder `new-…` disappears from behavior: history mode works after relaunch).
5. Session list shows merged sessions sorted by recency, Claude starburst / Codex hexagon icons tinted green/blue/orange/gray by status.
6. Click a Codex session → history view renders user/assistant/thinking/tool blocks; „Załaduj starsze…" paginates.
7. Resume a Codex session (terminal mode) → spawns `codex resume <id>`.
8. Export + rename + AI title generation work on a Codex session.
9. Mobile/remote regression: roster still lists only Claude sessions; remote resume of a Claude session still works.

- [ ] **Step 3: Update docs.** Add a short „Providers" section to `DesktopApp/CLAUDE.md` (folder map entry for `sessions/codex/`, the `Provider` enum, and the v1 decisions list from this plan's header). Commit:

```bash
git add DesktopApp/CLAUDE.md
git commit -m "docs(desktop): document multi-provider CLI architecture"
```
