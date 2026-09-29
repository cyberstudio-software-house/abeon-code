# Cross-project Session Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent running in one AbeonCode project run one Bash command
(`abeon-code session <path> <<'ABEON_PROMPT' … ABEON_PROMPT`). That command opens a
background Claude Code session in another project, which has already received the prompt.

**Architecture:**
1. The existing `abeon-code` wrapper gains a `session` mode. It validates the input, then
   launches the app binary detached with `--prompt <text> --background`.
2. `tauri-plugin-single-instance` forwards argv to the running app. A new pure argv parser
   turns it into an `OpenRequest`, which flows through the existing
   `dispatch_open` → `cli://open-path` → `openProjectPath` path.
3. The frontend creates a background Claude tab carrying `initialPrompt`.
4. `TerminalView` passes the prompt once in `PtyKind::Agent.initial_prompt`. Rust appends it,
   shell-quoted, to the `claude --session-id …` command.
5. A Claude Code skill, installed from Settings, teaches agents the invocation.

**Tech Stack:** Rust (Tauri 2, serde, ts-rs), bash (wrapper script), React 19 + Zustand +
Vitest, `sonner` toasts.

**Spec:** `docs/superpowers/specs/2026-09-29-cross-project-session-launch-design.md`

## Global Constraints

- All code identifiers are English. User-facing UI text is Polish. **No code comments.**
- Commits use Conventional Commits with scope `desktop` (e.g. `feat(desktop): …`), with no
  co-author trailer and no Claude session trailer.
- Run npm and cargo from `DesktopApp/`. `npm test` runs frontend tests and
  `npm run test:rust` runs Rust tests. ts-rs regenerates `src/types/*.ts` only during
  `cargo test`.
- A new ts-rs type must be re-exported manually in `DesktopApp/src/types/index.ts`.
- `MAX_INITIAL_PROMPT_BYTES = 100_000`, identical in the Rust constant and the wrapper script.
- Deep links (`abeon-code://…`) never carry a prompt or the background flag.
- Sessions started with a prompt always use provider `claude`.
- The `claude` CLI honours `--` before a positional prompt (verified 2026-09-29, v2.1.284).

## Review Focus

1. **Cold start from an agent's Bash tool.** When AbeonCode is not running, the wrapper
   must return immediately (detached launch), not block until the app exits. Pinned by the
   Task 3 test "session mode returns before the launched exe finishes".
2. **Hostile prompt content** (`'`, `$(…)`, backticks, `\`, newlines, leading `-`,
   unicode) must reach `claude` verbatim. Pinned by the Task 1 round-trip test, which goes
   through real `bash -c`.
3. **Double send.** A remount of the terminal layer (split view, StrictMode, mode switch)
   must not submit the prompt twice. Pinned by the Task 7 test "does not resend after
   remount".
4. **Prompt value mistaken for a path.** `--prompt "/some/dir"` or `--prompt "--x"` must
   not open an extra project. Pinned by Task 2 parser tests.
5. **Background tab stealing focus.** When another tab is active, the new tab must not
   become active and the focused pane must not change. Pinned by the Task 5
   `startBackgroundSessionTab` tests.

---

## File Structure

| File | Responsibility |
|---|---|
| `DesktopApp/src-tauri/src/commands/pty.rs` (modify) | `PtyKind::Agent.initial_prompt`, `shell_single_quote`, `append_initial_prompt`, `validate_initial_prompt`, wiring in `spawn_pty` |
| `DesktopApp/src-tauri/src/remote/dispatch.rs` (modify) | Test constructors get the new field |
| `DesktopApp/src-tauri/src/cli/request.rs` (create) | `OpenRequest` type + `parse_cli_args` |
| `DesktopApp/src-tauri/src/cli/mod.rs` (modify) | `dispatch_open(OpenRequest)`, `scan_args_into_pending` via parser |
| `DesktopApp/src-tauri/src/state.rs` (modify) | `pending_open_paths: Mutex<Vec<OpenRequest>>` |
| `DesktopApp/src-tauri/src/commands/cli.rs` (modify) | `take_pending_open_paths` returns `Vec<OpenRequest>`; new `install_claude_skill` |
| `DesktopApp/src-tauri/src/lib.rs` (modify) | Deep-link handler builds path-only `OpenRequest`; register `install_claude_skill` |
| `DesktopApp/src-tauri/src/cli/installer.rs` (modify) | Wrapper script `session` mode |
| `DesktopApp/src-tauri/src/cli/skill.rs` (create) | SKILL.md content + installer |
| `DesktopApp/src/types/OpenRequest.ts` (generated) + `src/types/index.ts` (modify) | TS type |
| `DesktopApp/src/lib/promptTitle.ts` (create) | `promptTabTitle(prompt)` |
| `DesktopApp/src/store/tabsSlice.ts` (modify) | `initialPrompt` field, `startBackgroundSessionTab`, `consumeInitialPrompt` |
| `DesktopApp/src/lib/tauri.ts` (modify) | `PtyKindClient.initial_prompt`, `OpenRequest` bindings, `installClaudeSkill` |
| `DesktopApp/src/lib/openProject.ts` (modify) | `openProjectPath(req: OpenRequest)` + error toast |
| `DesktopApp/src/components/layout/AppShell.tsx`, `DesktopApp/src/store/index.ts` (modify) | Pass `OpenRequest` through |
| `DesktopApp/src/components/terminal/TerminalView.tsx` (modify) | Send and consume the prompt |
| `DesktopApp/src/components/dialogs/SettingsDialog.tsx` (modify) | Skill install section |

---

### Task 1: Rust — initial prompt in the Claude spawn

**Files:**
- Modify: `DesktopApp/src-tauri/src/commands/pty.rs` (enum at 15-37, `spawn_pty` at 168-217, tests module at 530+)
- Modify: `DesktopApp/src-tauri/src/remote/dispatch.rs:181-205` (test constructors)
- Regenerated: `DesktopApp/src/types/PtyKind.ts`

**Interfaces:**
- Produces:
  - `pub const MAX_INITIAL_PROMPT_BYTES: usize = 100_000;` (in `commands::pty`)
  - `PtyKind::Agent { …, initial_prompt: Option<String> }`: JSON field `initial_prompt`,
    `#[serde(default)]`
  - `fn shell_single_quote(s: &str) -> String`
  - `fn append_initial_prompt(cmd: String, prompt: Option<&str>) -> String`
  - `fn validate_initial_prompt(provider: Provider, fresh: bool, prompt: &str) -> AppResult<()>`

- [ ] **Step 1: Write the failing tests** (append inside `mod tests` in `pty.rs`)

```rust
    fn bash_echo(quoted: &str) -> String {
        let out = std::process::Command::new("bash")
            .arg("-c")
            .arg(format!("printf %s {quoted}"))
            .output()
            .expect("bash");
        String::from_utf8(out.stdout).expect("utf8")
    }

    #[test]
    fn shell_single_quote_round_trips_hostile_input() {
        let inputs = [
            "plain",
            "it's",
            "'''",
            "$(id) `whoami` $HOME",
            "back\\slash \\' mix",
            "line one\nline two\n\nline four",
            "-starts-with-dash",
            "--help",
            "zażółć gęślą jaźń 🚀",
            "\"double\" and 'single'",
            "",
        ];
        for input in inputs {
            assert_eq!(bash_echo(&shell_single_quote(input)), input, "input: {input:?}");
        }
    }

    #[test]
    fn append_initial_prompt_none_is_noop() {
        assert_eq!(
            append_initial_prompt("claude --session-id u1".into(), None),
            "claude --session-id u1"
        );
    }

    #[test]
    fn append_initial_prompt_goes_last_after_separator() {
        assert_eq!(
            append_initial_prompt("claude --session-id u1 --dangerously-skip-permissions".into(), Some("fix it's bug")),
            "claude --session-id u1 --dangerously-skip-permissions -- 'fix it'\\''s bug'"
        );
    }

    #[test]
    fn validate_initial_prompt_accepts_fresh_claude() {
        assert!(validate_initial_prompt(Provider::Claude, true, "do things").is_ok());
    }

    #[test]
    fn validate_initial_prompt_rejects_resume() {
        assert!(matches!(
            validate_initial_prompt(Provider::Claude, false, "x"),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn validate_initial_prompt_rejects_other_providers() {
        assert!(validate_initial_prompt(Provider::Codex, true, "x").is_err());
        assert!(validate_initial_prompt(Provider::Opencode, true, "x").is_err());
    }

    #[test]
    fn validate_initial_prompt_rejects_nul_and_oversize() {
        assert!(validate_initial_prompt(Provider::Claude, true, "a\0b").is_err());
        let big = "a".repeat(MAX_INITIAL_PROMPT_BYTES + 1);
        assert!(validate_initial_prompt(Provider::Claude, true, &big).is_err());
        let max = "a".repeat(MAX_INITIAL_PROMPT_BYTES);
        assert!(validate_initial_prompt(Provider::Claude, true, &max).is_ok());
    }

    #[test]
    fn validate_initial_prompt_rejects_blank() {
        assert!(validate_initial_prompt(Provider::Claude, true, "  \n\t").is_err());
    }

    #[test]
    fn pty_kind_deserializes_initial_prompt() {
        let kind: PtyKind = serde_json::from_str(
            r#"{"kind":"agent","provider":"claude","fresh":true,"initial_prompt":"hello"}"#,
        ).unwrap();
        assert!(matches!(kind, PtyKind::Agent { initial_prompt: Some(ref p), .. } if p == "hello"));
    }

    #[test]
    fn pty_kind_initial_prompt_defaults_to_none() {
        let kind: PtyKind = serde_json::from_str(r#"{"kind":"agent","provider":"claude"}"#).unwrap();
        assert!(matches!(kind, PtyKind::Agent { initial_prompt: None, .. }));
    }
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd DesktopApp/src-tauri && cargo test --lib commands::pty 2>&1 | tail -20`
Expected: compile errors: `cannot find function shell_single_quote`,
`append_initial_prompt`, `validate_initial_prompt`, `MAX_INITIAL_PROMPT_BYTES`, and
`no field initial_prompt`.

- [ ] **Step 3: Implement**

In the `PtyKind::Agent` variant, add after `fresh`:

```rust
        #[serde(default)]
        fresh: bool,
        #[serde(default)]
        initial_prompt: Option<String>,
```

Add below `const MAX_EFFORT_LEN`:

```rust
pub const MAX_INITIAL_PROMPT_BYTES: usize = 100_000;

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn append_initial_prompt(cmd: String, prompt: Option<&str>) -> String {
    match prompt {
        Some(p) => format!("{cmd} -- {}", shell_single_quote(p)),
        None => cmd,
    }
}

fn validate_initial_prompt(provider: Provider, fresh: bool, prompt: &str) -> AppResult<()> {
    if provider != Provider::Claude || !fresh {
        return Err(AppError::InvalidInput("initial prompt is only supported for new Claude sessions".into()));
    }
    if prompt.trim().is_empty() {
        return Err(AppError::InvalidInput("initial prompt is empty".into()));
    }
    if prompt.contains('\0') {
        return Err(AppError::InvalidInput("initial prompt contains a NUL byte".into()));
    }
    if prompt.len() > MAX_INITIAL_PROMPT_BYTES {
        return Err(AppError::InvalidInput(format!(
            "initial prompt exceeds {MAX_INITIAL_PROMPT_BYTES} bytes"
        )));
    }
    Ok(())
}
```

In `spawn_pty`, change the Agent arm destructuring and the command build:

```rust
        PtyKind::Agent { provider, session_id, model, effort, skip_permissions, fresh, initial_prompt } => {
            if let Some(id) = session_id {
                crate::validation::validate_session_id(id)?;
            }
            if let Some(p) = initial_prompt.as_deref() {
                validate_initial_prompt(*provider, *fresh, p)?;
            }
```

Keep the existing comment above `validate_session_id` unchanged. Then replace
`let cmd = build_agent_command(…);` with:

```rust
            let cmd = append_initial_prompt(
                build_agent_command(
                    *provider,
                    session_id.as_deref(),
                    effective_model.as_deref(),
                    effort.as_deref(),
                    *skip_permissions,
                    *fresh,
                ),
                initial_prompt.as_deref(),
            );
```

In `remote/dispatch.rs` tests, add `initial_prompt: None,` to each of the three
`PtyKind::Agent { … }` literals, after `fresh: …,`.

- [ ] **Step 4: Run the tests and verify they pass; regenerate TS**

Run: `cd DesktopApp && npm run test:rust 2>&1 | tail -15`
Expected: all tests pass. `git diff src/types/PtyKind.ts` shows the new
`initial_prompt?: string | null` / `initial_prompt: string | null` field.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/commands/pty.rs DesktopApp/src-tauri/src/remote/dispatch.rs DesktopApp/src/types/PtyKind.ts
git commit -m "feat(desktop): accept an initial prompt when spawning a new Claude session"
```

---

### Task 2: Rust — `OpenRequest` argv parsing and dispatch

**Files:**
- Create: `DesktopApp/src-tauri/src/cli/request.rs`
- Modify: `DesktopApp/src-tauri/src/cli/mod.rs`, `DesktopApp/src-tauri/src/state.rs:122,138`, `DesktopApp/src-tauri/src/commands/cli.rs:6-10`, `DesktopApp/src-tauri/src/lib.rs:49-58`
- Generated: `DesktopApp/src/types/OpenRequest.ts`; Modify: `DesktopApp/src/types/index.ts`

**Interfaces:**
- Consumes: `open_input::parse_open_input(raw: &str, base_cwd: Option<&str>) -> Option<String>` (existing).
- Produces:
  - `pub struct OpenRequest { pub path: String, pub initial_prompt: Option<String>, pub background: bool }`
    - derives `Serialize, Clone, Debug, PartialEq, TS`
    - `#[serde(rename_all = "camelCase")]`, so JSON is `{ path, initialPrompt, background }`
    - TS type `{ path: string, initialPrompt: string | null, background: boolean }`
  - `impl OpenRequest { pub fn path_only(path: String) -> Self }`
  - `pub fn parse_cli_args(args: &[String], cwd: Option<&str>) -> Vec<OpenRequest>`: `args`
    includes argv[0]
  - `pub fn dispatch_open(app: &AppHandle, req: OpenRequest)`
  - `take_pending_open_paths` returns `Vec<OpenRequest>`

- [ ] **Step 1: Write the failing tests** (`cli/request.rs`, full file for now)

```rust
use serde::Serialize;
use ts_rs::TS;

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(rest: &[&str]) -> Vec<String> {
        std::iter::once("abeoncode").chain(rest.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn bare_path() {
        assert_eq!(
            parse_cli_args(&argv(&["/home/u/proj"]), None),
            vec![OpenRequest::path_only("/home/u/proj".into())]
        );
    }

    #[test]
    fn path_with_prompt_and_background() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt", "line1\nline2", "--background"]), None),
            vec![OpenRequest {
                path: "/p".into(),
                initial_prompt: Some("line1\nline2".into()),
                background: true,
            }]
        );
    }

    #[test]
    fn options_before_path_apply_to_it() {
        assert_eq!(
            parse_cli_args(&argv(&["--background", "--prompt", "x", "/p"]), None),
            vec![OpenRequest { path: "/p".into(), initial_prompt: Some("x".into()), background: true }]
        );
    }

    #[test]
    fn prompt_value_that_looks_like_path_is_not_a_path() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt", "/other/dir"]), None),
            vec![OpenRequest { path: "/p".into(), initial_prompt: Some("/other/dir".into()), background: false }]
        );
    }

    #[test]
    fn prompt_value_that_looks_like_flag_is_consumed() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt", "--background"]), None),
            vec![OpenRequest { path: "/p".into(), initial_prompt: Some("--background".into()), background: false }]
        );
    }

    #[test]
    fn dangling_prompt_flag_is_ignored() {
        assert_eq!(
            parse_cli_args(&argv(&["/p", "--prompt"]), None),
            vec![OpenRequest::path_only("/p".into())]
        );
    }

    #[test]
    fn options_without_path_produce_nothing() {
        assert!(parse_cli_args(&argv(&["--prompt", "x", "--background"]), None).is_empty());
    }

    #[test]
    fn legacy_inputs_keep_working() {
        assert_eq!(parse_cli_args(&argv(&["-psn_0_123"]), None), vec![]);
        assert_eq!(
            parse_cli_args(&argv(&["proj"]), Some("/work")),
            vec![OpenRequest::path_only("/work/proj".into())]
        );
        assert_eq!(
            parse_cli_args(&argv(&["abeon-code://open?path=%2Fx%2Fy"]), None),
            vec![OpenRequest::path_only("/x/y".into())]
        );
    }

    #[test]
    fn deep_link_never_carries_prompt() {
        let reqs = parse_cli_args(
            &argv(&["abeon-code://open?path=%2Fx&prompt=rm%20-rf&background=true"]),
            None,
        );
        assert_eq!(reqs, vec![OpenRequest::path_only("/x".into())]);
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_value(OpenRequest {
            path: "/p".into(),
            initial_prompt: Some("x".into()),
            background: true,
        }).unwrap();
        assert_eq!(json, serde_json::json!({ "path": "/p", "initialPrompt": "x", "background": true }));
    }
}
```

Register the module in `cli/mod.rs`: add `pub mod request;` next to `pub mod open_input;`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd DesktopApp/src-tauri && cargo test --lib cli::request 2>&1 | tail -15`
Expected: compile errors for `OpenRequest` / `parse_cli_args`.

- [ ] **Step 3: Implement**

Top of `cli/request.rs` (above `#[cfg(test)]`):

```rust
use serde::Serialize;
use ts_rs::TS;
use super::open_input::parse_open_input;

const PROMPT_FLAG: &str = "--prompt";
const BACKGROUND_FLAG: &str = "--background";
const DEEP_LINK_SCHEME: &str = "abeon-code://";

#[derive(Serialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub path: String,
    pub initial_prompt: Option<String>,
    pub background: bool,
}

impl OpenRequest {
    pub fn path_only(path: String) -> Self {
        Self { path, initial_prompt: None, background: false }
    }
}

pub fn parse_cli_args(args: &[String], cwd: Option<&str>) -> Vec<OpenRequest> {
    let mut paths: Vec<(String, bool)> = Vec::new();
    let mut prompt: Option<String> = None;
    let mut background = false;
    let mut iter = args.iter().skip(1);
    while let Some(raw) = iter.next() {
        if raw == PROMPT_FLAG {
            if let Some(value) = iter.next() {
                prompt = Some(value.clone());
            }
            continue;
        }
        if raw == BACKGROUND_FLAG {
            background = true;
            continue;
        }
        if let Some(path) = parse_open_input(raw, cwd) {
            paths.push((path, raw.starts_with(DEEP_LINK_SCHEME)));
        }
    }
    paths
        .into_iter()
        .map(|(path, from_deep_link)| {
            if from_deep_link {
                OpenRequest::path_only(path)
            } else {
                OpenRequest { path, initial_prompt: prompt.clone(), background }
            }
        })
        .collect()
}
```

Remove the duplicate `use serde::Serialize; use ts_rs::TS;` lines that Step 1 placed at the
top.

`cli/mod.rs`, replacing the body after the `pub mod` lines:

```rust
pub mod open_input;
pub mod installer;
pub mod request;

use tauri::{AppHandle, Emitter, Manager};
use crate::state::AppState;
use request::OpenRequest;

pub fn dispatch_open(app: &AppHandle, req: OpenRequest) {
    let state = app.state::<AppState>();
    let ready = *state.cli_frontend_ready.lock();
    if !ready {
        state.pending_open_paths.lock().push(req);
        return;
    }
    let background = req.background;
    let _ = app.emit("cli://open-path", req);
    if background {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn scan_args_into_pending(app: &AppHandle, args: &[String], cwd: Option<&str>) {
    for req in request::parse_cli_args(args, cwd) {
        dispatch_open(app, req);
    }
}
```

`state.rs`: `pub pending_open_paths: Mutex<Vec<crate::cli::request::OpenRequest>>,` (the
initializer `Mutex::new(Vec::new())` is unchanged).

`commands/cli.rs`:

```rust
#[tauri::command]
pub fn take_pending_open_paths(state: State<AppState>) -> Vec<crate::cli::request::OpenRequest> {
    *state.cli_frontend_ready.lock() = true;
    std::mem::take(&mut *state.pending_open_paths.lock())
}
```

`lib.rs` deep-link handler: replace the `dispatch_open(&handle, path)` call with
`crate::cli::dispatch_open(&handle, crate::cli::request::OpenRequest::path_only(path));`.

`src/types/index.ts`: add `export type { OpenRequest } from './OpenRequest';` next to the
`PtyKind` export.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd DesktopApp && npm run test:rust 2>&1 | tail -15 && ls src/types/OpenRequest.ts`
Expected: all tests pass and the file exists. `npm run lint` fails at this point only
where the frontend still passes `string` to `openProjectPath` (fixed in Task 6). Do not
fix it here.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/cli DesktopApp/src-tauri/src/state.rs DesktopApp/src-tauri/src/commands/cli.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/types/OpenRequest.ts DesktopApp/src/types/index.ts
git commit -m "feat(desktop): parse CLI open requests with prompt and background flags"
```

---

### Task 3: Rust — wrapper script `session` mode

**Files:**
- Modify: `DesktopApp/src-tauri/src/cli/installer.rs`

**Interfaces:**
- Consumes: `crate::commands::pty::MAX_INITIAL_PROMPT_BYTES` (Task 1).
- Produces: the shell contract
  `abeon-code session <dir>` + prompt on stdin → detached
  `<exe> <abs-dir> --prompt <prompt> --background`, exit 0. On error: exit 2 and an
  `abeon-code: …` message on stderr.

- [ ] **Step 1: Write the failing tests** (add to `mod tests` in `installer.rs`)

```rust
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn fake_exe(dir: &Path, delay_secs: u32) -> PathBuf {
        let exe = dir.join("fake-exe");
        std::fs::write(
            &exe,
            format!(
                "#!/usr/bin/env bash\nsleep {delay_secs}\nprintf '%s\\0' \"$@\" > \"$ABEON_TEST_OUT.tmp\"\nmv \"$ABEON_TEST_OUT.tmp\" \"$ABEON_TEST_OUT\"\n"
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        exe
    }

    fn run_wrapper(wrapper: &Path, args: &[&str], stdin: &str, out: &Path) -> std::process::Output {
        let mut child = Command::new("bash")
            .arg(wrapper)
            .args(args)
            .env("ABEON_TEST_OUT", out)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }

    fn wait_for_argv(out: &Path) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !out.exists() {
            assert!(Instant::now() < deadline, "fake exe never ran");
            std::thread::sleep(Duration::from_millis(50));
        }
        let raw = std::fs::read(out).unwrap();
        raw.split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8(s.to_vec()).unwrap())
            .collect()
    }

    #[test]
    fn session_mode_passes_prompt_verbatim_and_background() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let prompt = "Fix it's \"bug\"\n$(id) `x`\n-dash line\nzażółć";
        let res = run_wrapper(&wrapper, &["session", project.to_str().unwrap()], prompt, &out);
        assert!(res.status.success(), "stderr: {}", String::from_utf8_lossy(&res.stderr));
        let canonical = std::fs::canonicalize(&project).unwrap();
        assert_eq!(
            wait_for_argv(&out),
            vec![canonical.to_string_lossy().to_string(), "--prompt".into(), prompt.into(), "--background".into()]
        );
    }

    #[test]
    fn session_mode_returns_before_the_launched_exe_finishes() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 3);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let started = Instant::now();
        let res = run_wrapper(&wrapper, &["session", project.to_str().unwrap()], "hello", &out);
        assert!(res.status.success());
        assert!(started.elapsed() < Duration::from_secs(2), "wrapper blocked on the exe");
        wait_for_argv(&out);
    }

    #[test]
    fn session_mode_rejects_empty_prompt() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &["session", dir.path().to_str().unwrap()], "  \n\t\n", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: empty prompt"));
    }

    #[test]
    fn session_mode_rejects_missing_directory() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &["session", "/definitely/not/here"], "x", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: not a directory"));
    }

    #[test]
    fn session_mode_rejects_missing_path_argument() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &["session"], "x", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: usage"));
    }

    #[test]
    fn session_mode_rejects_oversized_prompt() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let big = "a".repeat(crate::commands::pty::MAX_INITIAL_PROMPT_BYTES + 1);
        let res = run_wrapper(&wrapper, &["session", dir.path().to_str().unwrap()], &big, &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: prompt too long"));
    }

    #[test]
    fn legacy_mode_still_execs_with_absolute_path() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let res = run_wrapper(&wrapper, &[project.to_str().unwrap()], "", &out);
        assert!(res.status.success());
        let canonical = std::fs::canonicalize(&project).unwrap();
        assert_eq!(wait_for_argv(&out), vec![canonical.to_string_lossy().to_string()]);
    }
```

Note: the tempdir may sit under a symlinked `/tmp`. The wrapper's `cd … && pwd` yields
the logical path while `canonicalize` yields the physical one. If the first test fails
only on that difference, change the wrapper to use `pwd -P` in **both** modes and keep the
assertions on `canonicalize`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd DesktopApp/src-tauri && cargo test --lib cli::installer 2>&1 | tail -20`
Expected: the `session_mode_*` tests fail (the legacy wrapper treats `session` as a path);
`legacy_mode_still_execs_with_absolute_path` passes.

- [ ] **Step 3: Implement** (replace `wrapper_script`)

```rust
use crate::commands::pty::MAX_INITIAL_PROMPT_BYTES;

pub fn wrapper_script(exe_path: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
exe="{exe_path}"
max_prompt_bytes={MAX_INITIAL_PROMPT_BYTES}

fail() {{
  echo "abeon-code: $1" >&2
  exit 2
}}

if [ "${{1:-}}" = "session" ]; then
  target="${{2:-}}"
  [ -n "$target" ] || fail "usage: abeon-code session <project-dir> <<'ABEON_PROMPT' ... ABEON_PROMPT"
  [ -d "$target" ] || fail "not a directory: $target"
  [ ! -t 0 ] || fail "expected the prompt on stdin (use a heredoc)"
  prompt="$(cat)"
  [[ $prompt =~ [^[:space:]] ]] || fail "empty prompt"
  bytes="$(printf '%s' "$prompt" | wc -c | tr -d ' ')"
  [ "$bytes" -le "$max_prompt_bytes" ] || fail "prompt too long ($bytes bytes, max $max_prompt_bytes)"
  abs="$(cd "$target" && pwd -P)"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$exe" "$abs" --prompt "$prompt" --background </dev/null >/dev/null 2>&1 &
  else
    nohup "$exe" "$abs" --prompt "$prompt" --background </dev/null >/dev/null 2>&1 &
  fi
  echo "abeon-code: session requested in $abs"
  exit 0
fi

target="${{1:-.}}"
if [ -d "$target" ]; then
  abs="$(cd "$target" && pwd -P)"
else
  abs="$(cd "$(dirname -- "$target")" 2>/dev/null && pwd -P)/$(basename -- "$target")"
fi
exec "$exe" "$abs"
"#
    )
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd DesktopApp/src-tauri && cargo test --lib cli::installer 2>&1 | tail -20`
Expected: all installer tests pass, including `script_contains_shebang_and_exe` and
`install_writes_executable_file`.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/cli/installer.rs
git commit -m "feat(desktop): add session mode to the abeon-code CLI wrapper"
```

---

### Task 4: Claude Code skill — installer command and Settings section

**Files:**
- Create: `DesktopApp/src-tauri/src/cli/skill.rs`
- Modify: `DesktopApp/src-tauri/src/cli/mod.rs` (add `pub mod skill;`), `DesktopApp/src-tauri/src/commands/cli.rs`, `DesktopApp/src-tauri/src/lib.rs` (invoke handler list, next to `commands::cli::install_cli_command` at line 79)
- Modify: `DesktopApp/src/lib/tauri.ts:46`, `DesktopApp/src/components/dialogs/SettingsDialog.tsx:360-395`

**Interfaces:**
- Produces:
  - `pub fn install(skills_root: &Path) -> AppResult<PathBuf>`: writes
    `<skills_root>/abeon-open-session/SKILL.md`
  - Tauri command `install_claude_skill() -> AppResult<String>`, which returns the written
    path
  - TS `tauri.installClaudeSkill(): Promise<string>`

- [ ] **Step 1: Write the failing test** (`cli/skill.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn install_writes_skill_file_and_overwrites() {
        let dir = tempdir().unwrap();
        let first = install(dir.path()).unwrap();
        assert_eq!(first, dir.path().join("abeon-open-session").join("SKILL.md"));
        std::fs::write(&first, "stale").unwrap();
        install(dir.path()).unwrap();
        let content = std::fs::read_to_string(&first).unwrap();
        assert!(content.starts_with("---\nname: abeon-open-session\n"));
        assert!(content.contains("abeon-code session"));
        assert!(content.contains("<<'ABEON_PROMPT'"));
    }
}
```

Add `pub mod skill;` to `cli/mod.rs`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd DesktopApp/src-tauri && cargo test --lib cli::skill 2>&1 | tail -10`
Expected: compile error, `cannot find function install`.

- [ ] **Step 3: Implement**

`cli/skill.rs` (above the tests):

```rust
use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};

const SKILL_DIR: &str = "abeon-open-session";

const SKILL_MD: &str = r#"---
name: abeon-open-session
description: Start a new Claude Code session in another project inside AbeonCode, seeded with a prompt. Use when the user asks to open, start, launch or spin up a new session / agent in a different project or repository, e.g. "odpal nową sesję w projekcie X", "uruchom sesję w X z promptem", "open a session in X and have it do Y".
---

# Open a session in another project (AbeonCode)

AbeonCode opens a new Claude Code session in the target project, in a background tab, and
submits your prompt as its first message. The user continues that session themselves.

## Steps

1. **Resolve the target project's absolute path.** Use the path the user gave, or one you
   know from context. If it is ambiguous or you are guessing, ask the user first. Never
   invent a path.
2. **Write a self-contained prompt.** The new session knows nothing about this
   conversation. Include:
   - the goal and why it is needed (which change in the current project depends on it)
   - relevant file paths, interfaces, names, error messages and findings from this session
   - constraints and decisions already made
   - what "done" looks like
3. **Run exactly this command** with the Bash tool. Keep the quoted delimiter, which
   prevents shell expansion inside the prompt:

   ```bash
   abeon-code session /absolute/path/to/project <<'ABEON_PROMPT'
   <prompt>
   ABEON_PROMPT
   ```

4. **Report the result.**
   - Exit code 0: tell the user the session was started in the background in that project.
     Mention the tab title, which is the first line of the prompt.
   - Non-zero: show the `abeon-code: …` message from stderr.
   - `command not found`: the user must install the command in AbeonCode → Ustawienia →
     Komenda terminala.

Do not use this to run work you could do in the current project, and do not start more
than one session per request unless the user asks for it.
"#;

pub fn install(skills_root: &Path) -> AppResult<PathBuf> {
    let dir = skills_root.join(SKILL_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let dest = dir.join("SKILL.md");
    std::fs::write(&dest, SKILL_MD).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dest)
}
```

`commands/cli.rs`: add `use crate::cli::skill;` and:

```rust
#[tauri::command]
pub fn install_claude_skill() -> AppResult<String> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home dir".into()))?;
    let dest = skill::install(&home.join(".claude").join("skills"))?;
    Ok(dest.to_string_lossy().to_string())
}
```

`lib.rs`: add `commands::cli::install_claude_skill,` right after
`commands::cli::install_cli_command,`.

`src/lib/tauri.ts`: after `installCliCommand`:

```ts
  installClaudeSkill: () => invoke<string>('install_claude_skill'),
```

`SettingsDialog.tsx`: add a component below `CliCommandSection`, modelled on it:

```tsx
function ClaudeSkillSection() {
  const [installedPath, setInstalledPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doInstall = () => {
    setError(null);
    tauri.installClaudeSkill()
      .then(setInstalledPath)
      .catch(err => setError(String(err?.message ?? err)));
  };

  return (
    <div className="space-y-2">
      <h3 className="text-[12px] font-semibold text-fg">Skill dla Claude Code</h3>
      <p className="text-[11px] text-muted">
        Instaluje skill <code className="mx-1">abeon-open-session</code> w
        <code className="mx-1">~/.claude/skills</code>. Pozwala agentowi uruchomić w tle nową
        sesję w innym projekcie z gotowym promptem, np. „odpal sesję w ~/projects/x i dodaj
        endpoint…”. Wymaga zainstalowanej komendy <code>abeon-code</code>.
      </p>
      <button onClick={doInstall} className="text-accent underline text-[12px]">
        Zainstaluj skill
      </button>
      {installedPath && (
        <p className="text-[11px] text-success">Zainstalowano: {installedPath}</p>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}
```

In `CliTab`, render `<ClaudeSkillSection />` after `<CliCommandSection />`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd DesktopApp && npm run test:rust 2>&1 | tail -10`
Expected: all Rust tests pass.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/src/cli DesktopApp/src-tauri/src/commands/cli.rs DesktopApp/src-tauri/src/lib.rs DesktopApp/src/lib/tauri.ts DesktopApp/src/components/dialogs/SettingsDialog.tsx
git commit -m "feat(desktop): install a Claude Code skill for opening sessions in other projects"
```

---

### Task 5: Frontend — background session tab with an initial prompt

**Files:**
- Create: `DesktopApp/src/lib/promptTitle.ts`, `DesktopApp/src/lib/promptTitle.test.ts`
- Modify: `DesktopApp/src/store/tabsSlice.ts` (Tab type at line 10, `TabsSlice` type, implementations near `startSessionTab` at 153)
- Test: `DesktopApp/src/store/tabsSlice.test.ts`

**Interfaces:**
- Produces:
  - `promptTabTitle(prompt: string): string`: first non-empty trimmed line, max 40 chars,
    with `…` appended when truncated, and `'New session'` when there is no non-empty line
  - `Tab` session variant field `initialPrompt?: string`
  - `startBackgroundSessionTab: (projectId: number, initialPrompt: string) => string`,
    which returns the tab id
  - `consumeInitialPrompt: (tabId: string) => void`

- [ ] **Step 1: Write the failing tests**

`src/lib/promptTitle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { promptTabTitle } from './promptTitle';

describe('promptTabTitle', () => {
  it('uses the first non-empty line', () => {
    expect(promptTabTitle('\n\n  Add endpoint  \nmore')).toBe('Add endpoint');
  });
  it('truncates to 40 chars with an ellipsis', () => {
    const line = 'a'.repeat(50);
    expect(promptTabTitle(line)).toBe(`${'a'.repeat(40)}…`);
  });
  it('keeps exactly 40 chars intact', () => {
    expect(promptTabTitle('b'.repeat(40))).toBe('b'.repeat(40));
  });
  it('falls back for blank prompts', () => {
    expect(promptTabTitle('  \n\t')).toBe('New session');
  });
});
```

Append to `src/store/tabsSlice.test.ts`:

```ts
describe('startBackgroundSessionTab', () => {
  beforeEach(() => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'a' }],
      activeTabId: 't1',
      mruOrder: ['t1'],
      navHistory: ['t1'],
      navIndex: 0,
      enabledProviders: ['codex', 'claude'],
    });
  });

  it('adds a claude tab carrying the prompt without activating it', () => {
    const before = useStore.getState();
    const id = useStore.getState().startBackgroundSessionTab(7, 'Add endpoint\ndetails');
    const s = useStore.getState();
    const tab = s.tabs.find(t => t.id === id);
    expect(tab).toMatchObject({
      kind: 'session', projectId: 7, provider: 'claude', fresh: true, mode: 'terminal',
      initialPrompt: 'Add endpoint\ndetails', title: 'Add endpoint',
    });
    expect(s.activeTabId).toBe('t1');
    expect(s.focusedPaneId).toBe(before.focusedPaneId);
    expect(s.navHistory).toEqual(['t1']);
    expect(s.mruOrder).toEqual(['t1', id]);
  });

  it('places the tab in the focused pane', () => {
    const id = useStore.getState().startBackgroundSessionTab(7, 'x');
    const s = useStore.getState();
    expect(findLeaf(s.layout, s.focusedPaneId)?.tabIds).toContain(id);
  });

  it('consumeInitialPrompt removes only the prompt', () => {
    const id = useStore.getState().startBackgroundSessionTab(7, 'x');
    useStore.getState().consumeInitialPrompt(id);
    const tab = useStore.getState().tabs.find(t => t.id === id);
    expect(tab && 'initialPrompt' in tab).toBe(false);
    expect(tab).toMatchObject({ kind: 'session', fresh: true, provider: 'claude' });
  });

  it('never persists the prompt to localStorage', () => {
    useStore.getState().startBackgroundSessionTab(7, 'SECRET-PROMPT');
    const dump = Object.keys(localStorage).map(k => localStorage.getItem(k) ?? '').join('\n');
    expect(dump).not.toContain('SECRET-PROMPT');
  });
});
```

Add `import { findLeaf } from '../lib/paneTree';` to the test file's imports. `tabsSlice.ts`
already imports the same helper.

The persistence test depends on the store's localStorage subscriber writing
synchronously. If tab persistence is debounced, call the test's fake-timer flush or
`vi.runAllTimers()` before reading `localStorage`, so the assertion is not vacuous.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd DesktopApp && npx vitest run src/lib/promptTitle.test.ts src/store/tabsSlice.test.ts 2>&1 | tail -20`
Expected: FAIL. The `./promptTitle` module is missing and `startBackgroundSessionTab` is
not a function.

- [ ] **Step 3: Implement**

`src/lib/promptTitle.ts`:

```ts
const MAX_TITLE_LENGTH = 40;
const FALLBACK_TITLE = 'New session';

export function promptTabTitle(prompt: string): string {
  const line = prompt.split('\n').map(l => l.trim()).find(l => l.length > 0);
  if (!line) return FALLBACK_TITLE;
  return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH)}…` : line;
}
```

`tabsSlice.ts`:
- In the `Tab` session variant, add `initialPrompt?: string` after `viewingSubagentId?: string`.
- In `TabsSlice`, after `startSessionTab`:

```ts
  startBackgroundSessionTab: (projectId: number, initialPrompt: string) => string;
  consumeInitialPrompt: (tabId: string) => void;
```

- Import: `import { promptTabTitle } from '../lib/promptTitle';`
- Implementations after `startSessionTab`:

```ts
  startBackgroundSessionTab: (projectId, initialPrompt) => {
    const sessionId = crypto.randomUUID();
    const id = sessionTabId(sessionId);
    set({
      tabs: [...get().tabs, {
        kind: 'session', id, projectId, sessionId, title: promptTabTitle(initialPrompt),
        mode: 'terminal', fresh: true, provider: 'claude', initialPrompt,
      }],
      mruOrder: [...get().mruOrder, id],
    });
    (get() as AppState).scheduleNewSessionRefresh(projectId);
    return id;
  },
  consumeInitialPrompt: (tabId) => {
    set({
      tabs: get().tabs.map(t => {
        if (t.id !== tabId || t.kind !== 'session' || t.initialPrompt === undefined) return t;
        const { initialPrompt, ...rest } = t;
        void initialPrompt;
        return rest;
      }),
    });
  },
```

`writeTabsToLocalStorage` (`src/store/index.ts:390-400`) already whitelists fields, so the
persistence test passes without changing it. Do not add `initialPrompt` there.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd DesktopApp && npx vitest run src/lib/promptTitle.test.ts src/store/tabsSlice.test.ts 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/promptTitle.ts DesktopApp/src/lib/promptTitle.test.ts DesktopApp/src/store/tabsSlice.ts DesktopApp/src/store/tabsSlice.test.ts
git commit -m "feat(desktop): open background Claude session tabs seeded with a prompt"
```

---

### Task 6: Frontend — route `OpenRequest` from the CLI to the store

**Files:**
- Modify: `DesktopApp/src/lib/tauri.ts:45-48`, `DesktopApp/src/lib/openProject.ts`, `DesktopApp/src/components/layout/AppShell.tsx:146`, `DesktopApp/src/store/index.ts:638-645`
- Test: `DesktopApp/src/lib/openProject.test.ts`

**Interfaces:**
- Consumes: `OpenRequest` from `../types` (Task 2); `startBackgroundSessionTab`,
  `setActive` (existing) from the store (Task 5).
- Produces: `openProjectPath(req: OpenRequest): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (replace the body of `openProject.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenRequest, Project } from '../types';

const findOrCreateProject = vi.fn();
const listProjects = vi.fn();
const toastError = vi.fn();

vi.mock('./tauri', () => ({
  tauri: {
    findOrCreateProject: (p: string) => findOrCreateProject(p),
    listProjects: () => listProjects(),
  },
}));
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m) } }));

import { openProjectPath } from './openProject';
import { useStore } from '../store';

const project: Project = {
  id: 42, name: 'demo', path: '/x/demo', claudeDir: '-x-demo',
  color: null, sortOrder: 0, createdAt: 0,
};

const req = (over: Partial<OpenRequest> = {}): OpenRequest => ({
  path: '/x/demo', initialPrompt: null, background: false, ...over,
});

describe('openProjectPath', () => {
  beforeEach(() => {
    findOrCreateProject.mockReset().mockResolvedValue(project);
    listProjects.mockReset().mockResolvedValue([project]);
    toastError.mockReset();
    useStore.setState({ tabs: [], activeTabId: null, mruOrder: [], enabledProviders: ['claude'] });
  });

  it('resolves the project then opens a new session tab', async () => {
    await openProjectPath(req());
    expect(findOrCreateProject).toHaveBeenCalledWith('/x/demo');
    expect(listProjects).toHaveBeenCalled();
    const tabs = useStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].projectId).toBe(42);
  });

  it('opens a background prompted tab without activating it', async () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'a' }],
      activeTabId: 't1',
      mruOrder: ['t1'],
    });
    await openProjectPath(req({ initialPrompt: 'Do X', background: true }));
    const s = useStore.getState();
    expect(s.activeTabId).toBe('t1');
    const created = s.tabs.find(t => t.kind === 'session');
    expect(created).toMatchObject({ projectId: 42, initialPrompt: 'Do X', provider: 'claude' });
  });

  it('activates a prompted tab when not in background', async () => {
    useStore.setState({
      tabs: [{ kind: 'terminal', id: 't1', projectId: 1, title: 'a' }],
      activeTabId: 't1',
      mruOrder: ['t1'],
    });
    await openProjectPath(req({ initialPrompt: 'Do X', background: false }));
    const s = useStore.getState();
    const created = s.tabs.find(t => t.kind === 'session');
    expect(s.activeTabId).toBe(created?.id);
  });

  it('shows a toast and opens nothing when the project cannot be resolved', async () => {
    findOrCreateProject.mockRejectedValue(new Error('bad path'));
    await expect(openProjectPath(req({ path: '/nope', initialPrompt: 'x', background: true }))).resolves.toBeUndefined();
    expect(useStore.getState().tabs.length).toBe(0);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('/nope'));
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd DesktopApp && npx vitest run src/lib/openProject.test.ts 2>&1 | tail -20`
Expected: FAIL. The prompted tests fail because no prompt is carried and the tab is
active, and `toastError` is never called.

- [ ] **Step 3: Implement**

`src/lib/openProject.ts`:

```ts
import { toast } from 'sonner';
import { tauri } from './tauri';
import { formatTauriError } from './errors';
import { useStore } from '../store';
import type { OpenRequest } from '../types';

export async function openProjectPath(req: OpenRequest): Promise<void> {
  try {
    const project = await tauri.findOrCreateProject(req.path);
    await useStore.getState().loadProjects();
    const store = useStore.getState();
    if (!req.initialPrompt) {
      store.openNewSessionTab(project.id);
      return;
    }
    const tabId = store.startBackgroundSessionTab(project.id, req.initialPrompt);
    if (!req.background) useStore.getState().setActive(tabId);
  } catch (err) {
    console.error('[cli] openProjectPath failed', req.path, err);
    toast.error(`Nie udało się otworzyć sesji w ${req.path}: ${formatTauriError(err)}`);
  }
}
```

`src/lib/tauri.ts`: add `OpenRequest` to the `../types` type import, then:

```ts
  takePendingOpenPaths: () => invoke<OpenRequest[]>('take_pending_open_paths'),
  ...
  onCliOpenPath: (cb: (req: OpenRequest) => void): Promise<UnlistenFn> =>
    listen<OpenRequest>('cli://open-path', e => cb(e.payload)),
```

`AppShell.tsx:146`: `tauri.onCliOpenPath((req) => { void openProjectPath(req); })`.

`store/index.ts` `drainPendingOpenPaths`:

```ts
    const requests = await tauri.takePendingOpenPaths();
    const { openProjectPath } = await import('../lib/openProject');
    for (const r of requests) await openProjectPath(r);
```

- [ ] **Step 4: Run the tests, typecheck, and verify they pass**

Run: `cd DesktopApp && npx vitest run src/lib/openProject.test.ts 2>&1 | tail -10 && npm run lint 2>&1 | tail -10`
Expected: PASS, and `tsc --noEmit` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/openProject.ts DesktopApp/src/lib/openProject.test.ts DesktopApp/src/lib/tauri.ts DesktopApp/src/components/layout/AppShell.tsx DesktopApp/src/store/index.ts
git commit -m "feat(desktop): route CLI open requests with prompts to background session tabs"
```

---

### Task 7: Frontend — `TerminalView` sends the prompt once

**Files:**
- Modify: `DesktopApp/src/lib/tauri.ts:23-24` (`PtyKindClient`), `DesktopApp/src/components/terminal/TerminalView.tsx:171-215,264-268`
- Test: `DesktopApp/src/components/terminal/TerminalView.test.tsx`

**Interfaces:**
- Consumes: `tab.initialPrompt` and `consumeInitialPrompt(tabId)` (Task 5); Rust field
  `initial_prompt` (Task 1).
- Produces: `PtyKindClient` agent variant with `initial_prompt?: string`.

Design note: `TerminalView` reads the prompt from the store **inside** the spawn effect
(`useStore.getState()`), not as a prop or effect dependency. Consuming the prompt changes
the tab, and a dependency would re-run the effect, which would kill and respawn the PTY.

- [ ] **Step 1: Write the failing tests** (append to `TerminalView.test.tsx`)

```tsx
import { tauri } from '../../lib/tauri';

describe('TerminalView initial prompt', () => {
  beforeEach(() => {
    vi.mocked(tauri.spawnPty).mockClear();
    useStore.setState({
      tabs: [{
        kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'T',
        mode: 'terminal', fresh: true, provider: 'claude', initialPrompt: 'Do X',
      }],
    });
  });

  const view = () => (
    <TerminalView projectId={1} kind="agent" provider="claude" sessionId="s1" fresh tabId="session:s1" visible focused />
  );

  it('passes initial_prompt on the first spawn and consumes it', async () => {
    await act(async () => { render(view()); });
    const kind = vi.mocked(tauri.spawnPty).mock.calls[0][1];
    expect(kind).toMatchObject({ kind: 'agent', provider: 'claude', fresh: true, initial_prompt: 'Do X' });
    const tab = useStore.getState().tabs[0];
    expect(tab.kind === 'session' && tab.initialPrompt).toBeFalsy();
  });

  it('does not resend after remount', async () => {
    let r!: ReturnType<typeof render>;
    await act(async () => { r = render(view()); });
    await act(async () => { r.unmount(); });
    await act(async () => { render(view()); });
    const calls = vi.mocked(tauri.spawnPty).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1][1]).not.toHaveProperty('initial_prompt');
  });

  it('omits initial_prompt when the tab has none', async () => {
    useStore.setState({
      tabs: [{ kind: 'session', id: 'session:s1', projectId: 1, sessionId: 's1', title: 'T', mode: 'terminal', fresh: true, provider: 'claude' }],
    });
    await act(async () => { render(view()); });
    expect(vi.mocked(tauri.spawnPty).mock.calls[0][1]).not.toHaveProperty('initial_prompt');
  });
});
```

If `import { tauri }` conflicts with the hoisted mock, reuse whatever handle the existing
tests use. The mock factory defines `tauri.spawnPty` as `vi.fn`, so `vi.mocked(...)` works.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd DesktopApp && npx vitest run src/components/terminal/TerminalView.test.tsx 2>&1 | tail -20`
Expected: FAIL, because `initial_prompt` is missing from the spawn kind.

- [ ] **Step 3: Implement**

`tauri.ts` `PtyKindClient` agent variant: add `initial_prompt?: string;` after `fresh?: boolean;`.

`TerminalView.tsx`:
- Add `const consumeInitialPrompt = useStore(s => s.consumeInitialPrompt);` next to
  `markSessionPtyStarted`.
- Before `const ptyKind: PtyKindClient =`, add:

```ts
    const seededTab = isNewClaudeAgent && tabId ? useStore.getState().tabs.find(t => t.id === tabId) : undefined;
    const initialPrompt = seededTab?.kind === 'session' ? seededTab.initialPrompt : undefined;
```

- In the agent object literal, after `...(fresh ? { fresh: true } : {}),`, add:

```ts
            ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
```

- In the `.then(async (id) => {` block, directly after `ptyRef.current = id;`, add:

```ts
      if (initialPrompt && tabId) consumeInitialPrompt(tabId);
```

- In the `.catch(error => {` block, inside `if (!cancelled)`, after the `term.write(...)`
  line, add:

```ts
        if (initialPrompt) toast.error(`Nie udało się uruchomić sesji z promptem: ${formatTauriError(error)}`);
```

  Add `import { toast } from 'sonner';`, and add `vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));`
  to the test file's mocks if the test environment has no `Toaster`. `toast.error` without
  a mounted Toaster is a no-op, so the mock is only needed if the import fails.
- Add `consumeInitialPrompt` to the spawn effect dependency array at line 284. It is a
  stable store function, like `markSessionPtyStarted`.

- [ ] **Step 4: Run the tests and verify they pass; run the full frontend suite**

Run: `cd DesktopApp && npx vitest run src/components/terminal/TerminalView.test.tsx 2>&1 | tail -10 && npm test 2>&1 | tail -15 && npm run lint 2>&1 | tail -5`
Expected: all pass, and tsc is clean. `NotesWorkspace.test` is known to flake under load;
re-run it once in isolation before treating a failure as real.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/lib/tauri.ts DesktopApp/src/components/terminal/TerminalView.tsx DesktopApp/src/components/terminal/TerminalView.test.tsx
git commit -m "feat(desktop): submit a tab's initial prompt once when its Claude session spawns"
```

---

### Task 8: End-to-end verification

**Files:** none (verification only; fix-ups go into the task they belong to, as a separate `fix(desktop): …` commit).

- [ ] **Step 1: Full automated suites**

Run: `cd DesktopApp && npm run test:rust 2>&1 | tail -5 && npm test 2>&1 | tail -5 && npm run lint 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 2: Build and run the app**

Run: `cd DesktopApp && npm run tauri dev` (background). In Settings → CLI:
1. Click "Zainstaluj komendę".
2. Click "Zainstaluj skill".
3. Verify that `~/.local/bin/abeon-code` and `~/.claude/skills/abeon-open-session/SKILL.md`
   exist.

Note: `abeon-code` points at the dev binary while `tauri dev` runs. Reinstall the
command from the release build after QA.

- [ ] **Step 3: Warm-start manual check from a shell**

```bash
abeon-code session ~/projects/cyberstudio/AbeonCode/CloudService <<'ABEON_PROMPT'
-x Say "it's $(ok)" and `nothing` else.
Second line.
ABEON_PROMPT
echo "exit=$?"
```

Expected:
- `exit=0` returns immediately.
- A tab titled `-x Say "it's $(ok)" and `nothing` else.` (truncated) appears in the
  focused pane without becoming active, and the window is not raised.
- Opening the tab shows Claude received both lines verbatim.

- [ ] **Step 4: Error paths from a shell**

Run each and check the exit code and stderr:
- `abeon-code session /nope <<<'x'` → exit 2, `not a directory`
- `abeon-code session . <<<'   '` → exit 2, `empty prompt`
- `abeon-code session .` in an interactive terminal → exit 2, `expected the prompt on stdin`

- [ ] **Step 5: Agent-driven check**

1. In an AbeonCode Claude session in project A, ask: "odpal nową sesję w
   <abs path of B> i niech sprawdzi, co jest w README".
2. Expected: the agent uses the `abeon-open-session` skill, the Bash call returns
   immediately, a background tab opens in B, and the attention marker appears when B's
   agent finishes.

- [ ] **Step 6: Cold start**

1. Quit AbeonCode fully.
2. From a terminal (or an agent outside AbeonCode) run the Step 3 command.
3. Expected: the command returns immediately, the app starts, and the prompted session
   tab exists.

- [ ] **Step 7: Deep link must not carry a prompt**

Run: `xdg-open 'abeon-code://open?path=%2Ftmp&prompt=hello&background=true'`
Expected: a normal new session tab for `/tmp` opens (focused, window raised, provider
picker if several providers are enabled), and **no** prompt is submitted.

- [ ] **Step 8: Report**

Summarize the results of Steps 1-7 to the user, including anything that did not behave as
expected. Leave the push/release decision to the user.
