# Cross-project session launch from an agent — design

Date: 2026-09-29 · App: `DesktopApp/` · Scope: `abeon-code` CLI wrapper, CLI argv parsing,
session tab creation, Claude PTY spawn, Settings (skill installer).

## Problem

While working in project A, the work often requires a change in project B. Today the user has
to switch to B, open a new session and retype the context by hand. The goal is to tell the
agent running in A something like "start a new session in project B with this prompt". AbeonCode
then opens a Claude Code session in B that has already received the prompt, and the user
continues there on their own.

Current state (verified in code):

- There is no way to start a session with an initial prompt. `PtyKind::Agent`
  (`src-tauri/src/commands/pty.rs:15-37`) and the `session` tab type
  (`src/store/tabsSlice.ts:10`) have no prompt field. The existing "inject text" paths
  (ClickUp "Wstaw do aktywnej sesji", remote `SendPrompt`) only write into an already
  running PTY.
- A process running inside a session has no channel back to the app. There is no local
  server and no injected env vars.
- The app already has a CLI entry point: the `~/.local/bin/abeon-code <path>` wrapper
  (`src-tauri/src/cli/installer.rs`), `tauri-plugin-single-instance`, which forwards argv to
  the running instance, and the path `dispatch_open` → `cli://open-path` → `openProjectPath`
  → `openNewSessionTab`. It works for projects not yet in the DB (`find_or_create`) and on
  cold start (first-launch argv is queued in `pending_open_paths`).

## Decisions (agreed with the user)

1. **Prompt is submitted immediately.** Claude starts with the prompt as its first message.
2. **Discovery through a Claude Code skill** installed by the app from Settings.
3. **Target project is identified by path only.** Name lookup is out of scope.
4. **Session opens in the background.** A new tab is created, but focus stays where it was
   and the window is not raised.
5. **Approach: extend the existing CLI + single-instance path.** A local HTTP/MCP server and a
   backend-only spawn were rejected (see "Rejected alternatives").
6. **Provider is always Claude Code** for sessions started this way, regardless of
   `enabledProviders` (no provider picker).

## Goals

1. An agent can run one Bash command that opens a background Claude session in any project
   path, with a multi-line prompt of arbitrary content.
2. The prompt reaches `claude` byte-for-byte, with no shell interpretation.
3. The prompt is sent exactly once per tab, even when the terminal view remounts or the app
   restarts.
4. Works whether AbeonCode is running or not.

## Non-goals

- Selecting the target project by name (`abeon-code projects` listing).
- A "draft" mode where the prompt is only pre-filled and not submitted.
- Codex / OpenCode as the target provider.
- Opening the session inside a detached `project-<id>` window. It always opens in the main
  window, as `abeon-code <path>` does today.
- Accepting a prompt through the `abeon-code://` deep link (deliberately forbidden, see
  Security).
- Reporting back to the calling agent after dispatch (e.g. "session id X started").

## CLI contract

Agent invocation:

```bash
abeon-code session /abs/path/to/project <<'ABEON_PROMPT'
...prompt, multiple lines, any characters...
ABEON_PROMPT
```

The wrapper script (`cli/installer.rs::wrapper_script`) gains a second mode:

- `abeon-code [<path>]` is unchanged.
- `abeon-code session <path>`:
  - fails with exit code ≠ 0 and a message on stderr when:
    - stdin is a TTY (no heredoc/pipe)
    - the prompt is empty after trimming whitespace
    - `<path>` is missing or not a directory
    - the prompt exceeds `MAX_INITIAL_PROMPT_BYTES` (100 000 bytes)
  - otherwise resolves `<path>` to an absolute directory and runs
    `exec "<exe>" "<abs>" --prompt "<prompt>" --background`.

All validation that can happen before dispatch lives in the wrapper. Single-instance
forwarding is fire-and-forget: the second process exits before the main instance handles
the request, so the wrapper is the only place that can return an error to the calling agent.

The prompt travels in argv, not in a temporary file. Linux allows 128 KiB per argument, and
the prompt ends up in `claude`'s argv anyway. A `--prompt-file` flag would force the app to
read and delete an externally supplied path. For example, `--prompt-file ~/.ssh/id_rsa`
would delete the user's key.

## Rust: argv parsing and dispatch

- New pure function in `cli/`:
  - signature: `parse_cli_args(args: &[String], cwd: Option<&str>) -> Vec<OpenRequest>`
  - `OpenRequest { path: String, initial_prompt: Option<String>, background: bool }`
  - `--prompt <value>` consumes the next argument as its value, so the value is never
    treated as a path.
  - `--background` is a boolean flag.
  - The options apply to the path they accompany. The wrapper emits exactly one path per call.
  - Unknown `-…` arguments (e.g. macOS `-psn_…`) are ignored, as today.
  - Relative paths, `~/`, and `.` behave as in the current `parse_open_input`.
- `scan_args_into_pending` uses `parse_cli_args`. The single-instance callback and the
  first-launch scan in `setup` share it, so warm and cold starts cannot diverge.
- **Deep links stay path-only.** The `abeon-code://` handler builds
  `OpenRequest { path, initial_prompt: None, background: false }` and never reads `prompt` or
  `background` from the query string.
- `dispatch_open(app, OpenRequest)`:
  - emits `cli://open-path` with payload `{ path, initialPrompt?, background }` (camelCase
    via serde).
  - raises/focuses the main window only when `background == false`.
  - queues the whole request, not only the path, when the frontend is not ready.
- `AppState.pending_open_paths` becomes `Vec<OpenRequest>`.
- `take_pending_open_paths` returns `Vec<OpenRequest>`.

## Rust: spawn

- `PtyKind::Agent` gains `initial_prompt: Option<String>` (`#[serde(default)]`).
- Validation in `spawn_pty`, before building the command. Each failure returns an
  `AppError`; nothing is silently dropped.
  - Rejected unless `provider == claude && fresh`.
  - Rejected if it contains a NUL byte.
  - Rejected if it exceeds `MAX_INITIAL_PROMPT_BYTES`.
- `build_claude_command` takes `initial_prompt: Option<&str>`. When present, it appends
  ` -- <shell_single_quote(prompt)>` as the last element, after
  `--dangerously-skip-permissions`.
- `shell_single_quote(s)` returns `'` + `s.replace('\'', "'\\''")` + `'`. This is required
  because the command runs as `bash -c "<cmd>"` (`pty.rs:206`).
- The `--` end-of-options separator protects prompts starting with `-`. Implementation must
  verify that the installed `claude` CLI honours `--` before a positional prompt in
  interactive mode. If it does not, drop `--` and instead guarantee the quoted prompt never
  starts with `-` (e.g. by prefixing a space). Record the outcome in the plan.
- Model, effort and `skip_permissions` come from the global settings, like any new session.

## Frontend

- `Tab` (`kind: 'session'`) gains `initialPrompt?: string`.
- New store action `startBackgroundSessionTab(projectId, initialPrompt)`:
  - creates a `session` tab with:
    - `provider: 'claude'`, `fresh: true`, `mode: 'terminal'`
    - `sessionId = crypto.randomUUID()`
    - `initialPrompt`
    - title = first non-empty line of the prompt, truncated to 40 characters with `…`
  - does **not** change `activeTabId`, `focusedPaneId` or navigation history, and appends
    the tab id to the end of `mruOrder`.
  - calls `scheduleNewSessionRefresh(projectId)`.
  - `reconcilePanes` (`src/lib/paneTree.ts`) then appends the tab to the focused pane and
    keeps that pane's active tab. No pane-tree change is needed.
  - returns the new tab id.
- `openProjectPath(req: OpenRequest)` (`src/lib/openProject.ts`):
  - `find_or_create` + `loadProjects`, as today.
  - with `initialPrompt`: `startBackgroundSessionTab`; if `background === false`, also
    activate the new tab.
  - without `initialPrompt`: `openNewSessionTab`, as today.
- `tauri.onCliOpenPath` and `tauri.takePendingOpenPaths` use the new `OpenRequest` payload.
  The TS type is generated by ts-rs; re-export it manually in `src/types/index.ts`.
- `TerminalView`:
  - includes `initial_prompt` in `PtyKindClient` only for a new Claude agent whose tab has
    `initialPrompt`.
  - calls `consumeInitialPrompt(tabId)` after `spawnPty` resolves, which removes the field
    from the tab.
- Tab persistence to localStorage strips `initialPrompt`. Restored tabs come back in
  `history` mode anyway, but the prompt must never be stored.
- Background tabs already spawn their PTY. All tab layers are rendered, and inactive ones
  are only `invisible` (`PaneLayout.tsx:55-78`), so xterm measures real dimensions and the
  output is buffered in `pendingWrites` until the tab is shown. When the agent finishes, the
  existing heuristic `session-attention` marks the tab.

## Skill

- New Rust command `install_claude_skill`:
  - writes `~/.claude/skills/abeon-open-session/SKILL.md`, overwriting any existing file
    (re-install = update).
  - the content is a Rust string constant in a new module next to `cli/installer.rs`.
- Settings gets an "Zainstaluj skill dla Claude Code" button next to the existing CLI
  command installer, with the same success/error feedback pattern. The skill depends on
  `abeon-code` being on PATH, and the button's help text says so.
- SKILL.md content (English, like other skill files):
  - frontmatter `name: abeon-open-session`, with a `description` that triggers on requests
    to start/open/launch a new session in another project (Polish and English phrasings).
  - Instructions:
    1. Resolve the target project's absolute path. Ask the user if it is ambiguous.
    2. Write a self-contained prompt. The new session has none of the current context, so
       include the goal, relevant file paths and findings, constraints, and a definition of
       done.
    3. Run the heredoc invocation with the quoted `'ABEON_PROMPT'` delimiter.
    4. On a non-zero exit, report stderr to the user. On success, tell the user the session
       started in the background in that project.

## Security

- **No prompt via deep link.** A web page can trigger `abeon-code://` URLs. If such a URL
  could carry a prompt, any website could start an agent with arbitrary instructions, which
  is remote code execution when `skip_permissions` is on. Only argv accepts a prompt, and
  only a local process of the same user can produce argv, which is the same trust level as
  today.
- **No shell interpretation of the prompt.** Single-quote escaping plus the property-based
  test below.
- No file paths are read or deleted on the prompt's behalf.

## Error handling

- Errors detected before dispatch are reported by the wrapper (exit code + stderr) and
  reach the calling agent.
- Errors after dispatch (`find_or_create` failure, spawn rejection, prompt validation in
  Rust) show a `toast.error(...)` from `sonner` (already used, e.g. `src/lib/detachGroup.ts`)
  instead of the current `console.error` only. The message is in Polish and names the project path. In background mode nobody would notice a console
  line.

## Testing

- **Rust unit tests:**
  - `parse_cli_args`:
    - bare path
    - path + `--prompt` + `--background`
    - `--prompt` value that looks like a path or a flag
    - `--prompt` without a value (ignored)
    - legacy cases (`-psn_…`, relative, `.`, `~/`)
  - Deep link with `prompt=` / `background=` in the query produces a path-only request.
  - `shell_single_quote` round-trip: for hostile inputs (`'`, `"`, `$(id)`, backticks,
    `\n`, `\`, leading `-`, unicode), `bash -c "printf %s <quoted>"` outputs exactly the
    input.
  - `build_claude_command` places the quoted prompt last and adds nothing when `None`.
  - Validation in spawn: prompt rejected for resume, for codex/opencode, for NUL, and over
    the size limit.
  - Wrapper script end-to-end, using a fake exe that dumps argv:
    - heredoc with a multi-line prompt yields the exact argv
    - errors for empty prompt, missing dir, too-long prompt
    - the legacy `abeon-code <path>` mode is unchanged
    - the TTY check is covered by manual QA
  - The skill installer writes the file at the expected path.
- **Vitest:**
  - `startBackgroundSessionTab`: `activeTabId` and `focusedPaneId` unchanged, tab placed in
    the focused pane, provider forced to claude even with several providers enabled, title
    derived from the prompt.
  - `openProjectPath` routing: with or without prompt, background true or false.
  - `TerminalView` sends `initial_prompt` on the first spawn and consumes it, so a remount
    does not resend it.
  - Persisted tabs never contain `initialPrompt`.
- **Manual QA:**
  - From a Claude session in project A, ask the agent to start a session in project B:
    - the tab appears in the background and Claude is working on the prompt
    - focus stays in A and the window is not raised
    - the attention marker appears when B's agent finishes
  - Cold start: quit the app, run `abeon-code session …` from a terminal, and check the app
    opens with the background session.
  - A prompt containing quotes, `$()`, and a line starting with `-` arrives verbatim.

## Rejected alternatives

- **Local HTTP server / MCP tool inside the app.** The app has no server today. This would
  add ports, tokens, and MCP registration for no gain, because the agent already has Bash.
- **Backend-only spawn** (like remote `ResumeSession`) followed by attaching the UI.
  `TerminalView` always spawns its own PTY and cannot attach to an existing one. That would
  be a large, unrelated refactor.
- **`--prompt-file` transport.** Unsafe read/delete of an externally supplied path; see
  "CLI contract".
