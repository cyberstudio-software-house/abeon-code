# OpenCode Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode as a fully usable desktop session provider for starting, resuming, discovering, reading, watching, exporting, and configuring coding sessions.

**Architecture:** A focused Rust adapter reads OpenCode 1.18.31 session data from its SQLite database while the OpenCode CLI handles PTYs, model discovery, and prompt execution. The existing provider-aware IPC and React surfaces receive `opencode`, and a new synchronization event refreshes mutable SQLite history by stable block UUID instead of treating it as append-only JSONL.

**Tech Stack:** Rust, rusqlite 0.37, Tauri 2 IPC/events, notify 8, React 19, TypeScript 5.8, Zustand 5, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-09-15-opencode-provider-design.md`

## Global Constraints

- Target the stable OpenCode 1.18.31 `session`, `message`, and `part` SQLite schema.
- Open the OpenCode database read-only; never migrate, checkpoint, or write it.
- Keep AbeonCloud, usage/cost tracking, limits, and OpenCode subagent presentation outside this version.
- Use English for every identifier and Polish for user-facing UI text.
- Do not add code comments; place durable explanations in `DesktopApp/CLAUDE.md`.
- Preserve Claude and Codex behavior, including Claude-only remote dispatch and subagents.
- Do not invoke a real model from automated tests.
- Run npm and cargo commands from `DesktopApp/`.
- Commit every completed task with Conventional Commits 1.0.0 and no co-author trailer.

---

## File Structure

### New files

- `DesktopApp/src-tauri/src/sessions/opencode/mod.rs` — module boundary and shared re-exports.
- `DesktopApp/src-tauri/src/sessions/opencode/parser.rs` — pure conversion of OpenCode message/part JSON into `HistoryBlock` values.
- `DesktopApp/src-tauri/src/sessions/opencode/reader.rs` — data-path resolution, read-only SQLite access, schema validation, session queries, pagination, revisions, and activity.
- `DesktopApp/src-tauri/src/sessions/opencode/runner.rs` — OpenCode model-output parsing and bounded non-interactive prompt execution with temporary-session cleanup.
- `DesktopApp/src/lib/historySync.ts` — stable-UUID merge for mutable history windows.
- `DesktopApp/src/lib/historySync.test.ts` — merge regression tests.

### Existing files with focused changes

- `DesktopApp/src-tauri/src/domain/provider.rs` — add `Provider::Opencode` serialized as `opencode`.
- `DesktopApp/src-tauri/src/commands/providers.rs` — detect the CLI and models.
- `DesktopApp/src-tauri/src/commands/pty.rs` — construct fresh/resume/model/auto OpenCode commands.
- `DesktopApp/src-tauri/src/commands/sessions.rs` — merge OpenCode sessions and dispatch history/export/title operations.
- `DesktopApp/src-tauri/src/sessions/watcher.rs` — support a database-backed watch source and emit sync events.
- `DesktopApp/src-tauri/src/sessions/activity.rs` — keep the file-based dispatcher exhaustive without routing OpenCode through it.
- `DesktopApp/src-tauri/src/sessions/limits.rs` — return empty limits for OpenCode.
- `DesktopApp/src-tauri/src/lib.rs` — register model detection.
- `DesktopApp/src/lib/providers.ts` — provider registry, label, icon, and validation.
- `DesktopApp/src/components/shared/Icon.tsx` — OpenCode provider glyph.
- `DesktopApp/src/store/tabsSlice.ts` and tests — placeholder tabs and picker selection.
- `DesktopApp/src/lib/windowMode.ts` and tests — detached-window provider parsing.
- `DesktopApp/src/store/settingsSlice.ts` and tests — OpenCode model settings.
- `DesktopApp/src/store/index.ts` — persist and hydrate OpenCode settings.
- `DesktopApp/src/lib/tauri.ts` — model detection and session-sync listeners.
- `DesktopApp/src/components/terminal/TerminalView.tsx` — pass the selected OpenCode model.
- `DesktopApp/src/components/dialogs/SettingsDialog.tsx` — provider title model and model catalog controls.
- `DesktopApp/src/components/history/HistoryHeader.tsx` — choose the OpenCode title-generation model.
- `DesktopApp/src/components/history/HistoryView.tsx` and tests — debounce sync events and merge refreshed history.
- `DesktopApp/src/components/right/UsageSection.tsx` and tests — present unsupported OpenCode usage/limits honestly.
- `DesktopApp/CLAUDE.md` — document storage, synchronization, and version limits.

---

### Task 1: OpenCode SQLite adapter and history parser

**Files:**
- Create: `DesktopApp/src-tauri/src/sessions/opencode/mod.rs`
- Create: `DesktopApp/src-tauri/src/sessions/opencode/parser.rs`
- Create: `DesktopApp/src-tauri/src/sessions/opencode/reader.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/mod.rs`

**Interfaces:**
- Consumes: `crate::domain::{HistoryBlock, SessionActivity}` and `crate::error::{AppError, AppResult}`.
- Produces: `database_path() -> Option<PathBuf>`, `list_for_directory(&Path, &str, usize) -> AppResult<Vec<StoredSession>>`, `count_for_directory(&Path, &str) -> AppResult<usize>`, `read_history(&Path, &str, Option<usize>, Option<&str>) -> AppResult<StoredHistory>`, `first_user_prompt(&Path, &str) -> AppResult<Option<String>>`, `session_revision(&Path, &str) -> AppResult<Option<SessionRevision>>`, and `last_assistant_text(&Path, &str) -> AppResult<Option<String>>`.

- [ ] **Step 1: Create failing parser tests for supported OpenCode parts**

Add `parser.rs` with tests that pass synthetic JSON values to this exact interface:

```rust
pub fn parse_part(
    message_id: &str,
    role: &str,
    message_created_at: i64,
    part_id: &str,
    part_created_at: i64,
    data: &serde_json::Value,
) -> Vec<HistoryBlock>;
```

Cover user text, assistant text, reasoning, pending tool input, completed tool output, failed tool error, file attachment, and an unknown type. Assert stable IDs such as `oc-prt_text` and `oc-prt_tool-result`.

```rust
#[test]
fn completed_tool_emits_use_and_result() {
    let data = serde_json::json!({
        "type": "tool",
        "tool": "bash",
        "state": {
            "status": "completed",
            "input": {"command": "pwd"},
            "output": "/tmp/project",
            "time": {"start": 100, "end": 120}
        }
    });
    let blocks = parse_part("msg_1", "assistant", 90, "prt_tool", 95, &data);
    assert!(matches!(&blocks[0], HistoryBlock::ToolUse { uuid, name, .. } if uuid == "oc-prt_tool" && name == "bash"));
    assert!(matches!(&blocks[1], HistoryBlock::ToolResult { uuid, content, is_error: false, .. } if uuid == "oc-prt_tool-result" && content == "/tmp/project"));
}
```

- [ ] **Step 2: Run the parser test and verify failure**

Run: `npm run test:rust -- sessions::opencode::parser::tests --nocapture`

Expected: FAIL because the `sessions::opencode` module and `parse_part` do not exist.

- [ ] **Step 3: Implement the pure history parser**

Implement `parse_part` with `serde_json::Value`, `crate::sessions::parser::summarize_input`, and these rules:

```rust
match data.get("type").and_then(Value::as_str).unwrap_or("") {
    "text" => parse_text(role, part_id, timestamp, data),
    "reasoning" if role == "assistant" => parse_reasoning(part_id, timestamp, data),
    "tool" if role == "assistant" => parse_tool(part_id, timestamp, data),
    "file" => parse_file(part_id, timestamp, data),
    _ => Vec::new(),
}
```

For tools, treat both `failed` and `error` as error states. Prefer `state.output`, then `state.error`, and serialize non-string output with `Value::to_string()`. Use `state.time.start` for `ToolUse`, `state.time.end` for `ToolResult`, then fall back to the part and message timestamps.

- [ ] **Step 4: Create failing reader tests on a synthetic SQLite database**

In `reader.rs`, define:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct StoredSession {
    pub id: String,
    pub title: String,
    pub message_count: usize,
    pub updated_at: i64,
    pub directory: String,
    pub activity: SessionActivity,
}

pub struct StoredHistory {
    pub session: StoredSession,
    pub blocks: Vec<HistoryBlock>,
    pub has_more_before: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionRevision {
    pub updated_at: i64,
    pub title: String,
    pub activity: SessionActivity,
}
```

Create a `test_database()` helper using `tempfile::NamedTempFile` and the exact required table subset:

```sql
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
```

Tests must prove exact-directory filtering, `parent_id IS NULL`, descending session order, message counts, flattened history order, `before_uuid` pagination, malformed-part skipping, first user prompt, last assistant text, missing database behavior, and schema mismatch errors.

- [ ] **Step 5: Run reader tests and verify failure**

Run: `npm run test:rust -- sessions::opencode::reader::tests --nocapture`

Expected: FAIL because the reader functions are not implemented.

- [ ] **Step 6: Implement read-only database access and schema validation**

Open with:

```rust
let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
let conn = rusqlite::Connection::open_with_flags(path, flags)?;
conn.busy_timeout(std::time::Duration::from_millis(750))?;
```

Validate required columns with `PRAGMA table_info(<table>)`. Return `AppError::Other("Nieobsługiwany schemat OpenCode: ...".into())` when required columns are absent. Return empty collections when `path` does not exist.

Resolve the data path with:

```rust
pub fn database_path() -> Option<PathBuf> {
    if let Some(base) = std::env::var_os("XDG_DATA_HOME") {
        let path = PathBuf::from(base).join("opencode").join("opencode.db");
        if path.exists() { return Some(path); }
    }
    if let Some(base) = dirs::data_dir() {
        let path = base.join("opencode").join("opencode.db");
        if path.exists() { return Some(path); }
    }
    dirs::home_dir()
        .map(|home| home.join(".local/share/opencode/opencode.db"))
        .filter(|path| path.exists())
}
```

Do not interpolate session IDs or directories into SQL. Bind all values with `rusqlite::params!`.

- [ ] **Step 7: Implement history querying, activity, and pagination**

Read messages by `(time_created, id)` and parts by `(time_created, id)`. Parse each message's `role` from `message.data`, then call `parse_part`. Compute `StoredSession.activity` from the newest meaningful part and `session.time_updated` with the existing constants: 5 seconds live, 30 seconds tool stall, 10 minutes running stall, 4 hours waiting decay, and 24 hours hard idle cap.

Use this activity input enum inside `reader.rs`:

```rust
enum LastEvent {
    UserText,
    AssistantText,
    ToolActive,
    ToolCompleted,
    ToolFailed,
}
```

Flatten blocks before applying `before_uuid`. Cap the requested limit to 500 and default it to 200.

- [ ] **Step 8: Run the focused Rust tests**

Run: `npm run test:rust -- sessions::opencode --nocapture`

Expected: PASS.

- [ ] **Step 9: Commit the adapter**

```bash
git add src-tauri/src/sessions/opencode src-tauri/src/sessions/mod.rs
git commit -m "feat(desktop): add OpenCode SQLite session adapter"
```

---

### Task 2: OpenCode prompt runner and model discovery

**Files:**
- Create: `DesktopApp/src-tauri/src/sessions/opencode/runner.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/opencode/mod.rs`
- Modify: `DesktopApp/src-tauri/src/commands/providers.rs`
- Modify: `DesktopApp/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `reader::last_assistant_text(&Path, &str)` and the existing shell environment helpers.
- Produces: `runner::parse_run_output(&str) -> AppResult<RunOutput>`, `runner::run_prompt(Option<&str>, &str) -> AppResult<String>`, and Tauri command `detect_opencode_models(state: State<AppState>) -> Vec<String>`.

- [ ] **Step 1: Write failing JSONL and model-list parser tests**

Define:

```rust
#[derive(Debug, PartialEq)]
pub struct RunOutput {
    pub session_id: Option<String>,
    pub text: Option<String>,
}
```

Use a test JSONL string containing `step_start`, `text`, and `step_finish` events. Assert that `sessionID` is captured from any valid event and the last non-empty `part.text` from a `type == "text"` event wins. Ignore malformed and unrelated lines.

In `commands/providers.rs`, test:

```rust
#[test]
fn parses_opencode_models_by_line() {
    assert_eq!(
        parse_opencode_models("anthropic/claude-sonnet-4-5\nopenai/gpt-5.4\nanthropic/claude-sonnet-4-5\n"),
        vec!["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"]
    );
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:rust -- sessions::opencode::runner::tests --nocapture`

Run: `npm run test:rust -- commands::providers::tests --nocapture`

Expected: FAIL because the runner and parsers do not exist.

- [ ] **Step 3: Implement JSONL parsing and the bounded runner**

Build the command without a shell:

```rust
let mut command = tokio::process::Command::new("opencode");
command.arg("run").arg("--format").arg("json");
if let Some(model) = model.filter(|value| !value.is_empty()) {
    command.arg("--model").arg(model);
}
command.arg(prompt);
command.current_dir(std::env::temp_dir());
command.kill_on_drop(true);
```

Use a 90-second timeout. After a successful process:

1. parse stdout;
2. if stdout has no text but has a session ID, resolve `database_path()` and call `last_assistant_text`;
3. run `opencode session delete <session-id>` with a 15-second timeout;
4. return stdout text or database fallback text;
5. return a Polish empty-output error when neither source contains text.

Attempt deletion after process failure whenever stdout exposed a session ID. Log deletion failure with `eprintln!` and preserve the main result.

- [ ] **Step 4: Implement OpenCode model detection**

`detect_opencode_models` must locate `opencode` with `commands::models::locate_binary`, load the selected-shell environment through `commands::settings::ensure_shell_env`, run `opencode models`, and parse successful stdout through `parse_opencode_models`. Return an empty vector on lookup, spawn, or non-zero-exit failure.

Register `commands::providers::detect_opencode_models` in `src-tauri/src/lib.rs`.

- [ ] **Step 5: Run focused and full Rust tests**

Run: `npm run test:rust -- sessions::opencode::runner::tests --nocapture`

Run: `npm run test:rust -- commands::providers::tests --nocapture`

Expected: PASS.

Run: `npm run test:rust`

Expected: PASS.

- [ ] **Step 6: Commit runner and model discovery**

```bash
git add src-tauri/src/sessions/opencode src-tauri/src/commands/providers.rs src-tauri/src/lib.rs
git commit -m "feat(desktop): add OpenCode prompt and model commands"
```

---

### Task 3: Backend provider integration and live database watcher

**Files:**
- Modify: `DesktopApp/src-tauri/src/domain/provider.rs`
- Modify: `DesktopApp/src-tauri/src/commands/providers.rs`
- Modify: `DesktopApp/src-tauri/src/commands/pty.rs`
- Modify: `DesktopApp/src-tauri/src/commands/sessions.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/opencode/reader.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/watcher.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/activity.rs`
- Modify: `DesktopApp/src-tauri/src/sessions/limits.rs`
- Generated: `DesktopApp/src/types/Provider.ts`

**Interfaces:**
- Consumes: all OpenCode adapter and runner functions from Tasks 1–2.
- Produces: serialized provider value `opencode`, OpenCode PTY commands, provider-dispatched session commands, and event `session:<id>:sync`.

- [ ] **Step 1: Write failing provider and PTY command tests**

Extend provider tests with:

```rust
assert_eq!(serde_json::to_string(&Provider::Opencode).unwrap(), "\"opencode\"");
assert_eq!(serde_json::from_str::<Provider>("\"opencode\"").unwrap(), Provider::Opencode);
assert_eq!(Provider::Opencode.id(), "opencode");
```

Add PTY builder expectations:

```rust
assert_eq!(build_agent_command(Provider::Opencode, None, None, false, true), "opencode");
assert_eq!(build_agent_command(Provider::Opencode, Some("ses_123"), None, false, false), "opencode --session ses_123");
assert_eq!(build_agent_command(Provider::Opencode, None, Some("anthropic/claude-sonnet-4-5"), true, true), "opencode --model anthropic/claude-sonnet-4-5 --auto");
```

Extend merged-list tests to interleave Claude, Codex, and OpenCode rows.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run test:rust -- domain::provider --nocapture`

Run: `npm run test:rust -- commands::pty::tests --nocapture`

Run: `npm run test:rust -- commands::sessions::merge_tests --nocapture`

Expected: FAIL because `Provider::Opencode` does not exist.

- [ ] **Step 3: Add the provider variant and exhaustive safe behavior**

Add `Opencode` to `Provider` and return `opencode` from `id()`. Update all exhaustive matches in the same change:

- `sessions/limits.rs`: return `ProviderLimits::default()`;
- `sessions/activity.rs`: return `SessionActivity::Idle` from the file-only dispatcher, because OpenCode activity comes from its database reader;
- `commands/providers.rs`: include OpenCode in detection;
- `commands/pty.rs`: dispatch to `build_opencode_command`;
- `commands/sessions.rs`: dispatch to the OpenCode reader and runner;
- `sessions/watcher.rs`: use the database-backed branch described below.

Run `npm run test:rust -- domain::provider --nocapture` once to regenerate `src/types/Provider.ts`.

- [ ] **Step 4: Map stored OpenCode rows into shared domain types**

Add these helpers to `opencode/reader.rs`:

```rust
pub fn into_session_meta(record: StoredSession, project_id: i64) -> SessionMeta {
    SessionMeta {
        id: record.id,
        project_id,
        title: record.title,
        message_count: record.message_count,
        last_modified: record.updated_at,
        git_branch: None,
        cwd: Some(record.directory),
        activity: record.activity,
        provider: Provider::Opencode,
        running_agents: 0,
        total_agents: 0,
    }
}
```

Add `into_session_history(StoredHistory, project_id) -> SessionHistory` using the same mapper.

- [ ] **Step 5: Wire list, count, history, export, prompt lookup, and title generation**

Change `merge_session_lists` to accept three vectors:

```rust
fn merge_session_lists(
    claude: Vec<SessionMeta>,
    codex: Vec<SessionMeta>,
    opencode: Vec<SessionMeta>,
    limit: usize,
    offset: usize,
) -> Vec<SessionMeta> {
    let mut all: Vec<SessionMeta> = claude.into_iter().chain(codex).chain(opencode).collect();
    all.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    all.into_iter().skip(offset).take(limit).collect()
}
```

For listing/counting, treat `database_path() == None` as zero OpenCode sessions. For explicit OpenCode history/export/title operations, return `AppError::NotFound` when the database or session is missing.

In `run_agent_prompt`, dispatch `Provider::Opencode` to `opencode::runner::run_prompt(model.as_deref(), &prompt).await`.

- [ ] **Step 6: Refactor the watcher source and write failing watcher tests**

Replace file-only state with:

```rust
enum WatchSource {
    File {
        path: PathBuf,
        last_offset: u64,
        lines_seen: usize,
        usage: UsageAccumulator,
    },
    OpenCode {
        database_path: PathBuf,
        revision: i64,
    },
}

struct OpenSession {
    provider: Provider,
    source: WatchSource,
}
```

Add tests for this pure matcher:

```rust
fn is_opencode_database_event(database_path: &Path, changed: &Path) -> bool;
```

It must accept the database path and its `-wal` companion, reject `-shm`, and reject files from other directories.

- [ ] **Step 7: Implement database-backed session synchronization**

Add `SessionWatchers::open_opencode(app, session_id, database_path)` that reads the initial revision, inserts `WatchSource::OpenCode`, and watches the database parent non-recursively.

When a matching DB/WAL event arrives:

1. call `opencode::reader::session_revision`;
2. compare `updated_at` to the stored revision;
3. update the stored revision;
4. emit `session:<id>:sync` with `{}`;
5. emit the existing activity event when the activity changed;
6. emit the existing title event with the native title.

Keep JSONL byte-offset behavior unchanged for `WatchSource::File`. Do not pass OpenCode through `read_tail` or `compute_activity_for`.

- [ ] **Step 8: Run Rust tests and fix all exhaustive matches**

Run: `npm run test:rust`

Expected: PASS with regenerated `src/types/Provider.ts` containing `"opencode"` and no non-exhaustive match errors.

- [ ] **Step 9: Commit backend integration**

```bash
git add src-tauri/src src/types/Provider.ts
git commit -m "feat(desktop): integrate OpenCode sessions and live updates"
```

---

### Task 4: Frontend provider, tabs, and detached windows

**Files:**
- Modify: `DesktopApp/src/lib/providers.ts`
- Modify: `DesktopApp/src/components/shared/Icon.tsx`
- Modify: `DesktopApp/src/store/tabsSlice.ts`
- Modify: `DesktopApp/src/store/tabsSlice.test.ts`
- Modify: `DesktopApp/src/store/sessionsSlice.test.ts`
- Modify: `DesktopApp/src/lib/windowMode.ts`
- Modify: `DesktopApp/src/lib/windowMode.test.ts`
- Modify: `DesktopApp/src/lib/openProject.test.ts`
- Modify: any frontend fixture that constructs an exhaustive `Record<Provider, ...>`

**Interfaces:**
- Consumes: generated `Provider = "claude" | "codex" | "opencode"`.
- Produces: `ALL_PROVIDERS`, `PROVIDER_LABEL`, `PROVIDER_ICON`, and `isProvider` that fully support OpenCode.

- [ ] **Step 1: Write failing provider plumbing tests**

Add tests asserting:

- `isProvider('opencode') === true`;
- a single enabled OpenCode provider creates a fresh `new-` session tab;
- choosing OpenCode from a three-provider picker preserves tab position and navigation history;
- `refreshActivity` links only an OpenCode placeholder to a newly discovered OpenCode session;
- a detached session URL round-trips `provider: 'opencode'`;
- a malformed provider query value is discarded.

Use this OpenCode metadata in the linking test:

```ts
{
  ...fakeMeta('ses_open', 1, 'running'),
  provider: 'opencode',
  title: 'OpenCode session',
}
```

- [ ] **Step 2: Run focused frontend tests and verify failure**

Run: `npm test -- src/store/tabsSlice.test.ts src/store/sessionsSlice.test.ts src/lib/windowMode.test.ts`

Expected: FAIL because `opencode` is rejected or absent from the provider registry.

- [ ] **Step 3: Implement the provider registry and icon**

Use:

```ts
export const ALL_PROVIDERS: Provider[] = ['claude', 'codex', 'opencode'];

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export const PROVIDER_ICON: Record<Provider, IconName> = {
  claude: 'claudeLogo',
  codex: 'openaiLogo',
  opencode: 'opencodeLogo',
};

export function isProvider(value: unknown): value is Provider {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}
```

Add a dedicated `opencodeLogo` SVG entry to `Icon.tsx`; keep it monochrome through `currentColor` so activity tinting remains unchanged.

- [ ] **Step 4: Generalize fresh-session and window parsing rules**

Keep the existing rule that only Claude pre-assigns IDs:

```ts
const sessionId = provider === 'claude' ? crypto.randomUUID() : `new-${crypto.randomUUID()}`;
```

In `windowMode.ts`, replace the Codex-only query check with:

```ts
const rawProvider = q.get('provider');
const provider = isProvider(rawProvider) ? rawProvider : undefined;
```

Do not change `TabContent`: its existing `provider === 'claude'` fresh-session condition already correctly omits placeholders for OpenCode.

- [ ] **Step 5: Run focused and full frontend tests**

Run: `npm test -- src/store/tabsSlice.test.ts src/store/sessionsSlice.test.ts src/lib/windowMode.test.ts src/lib/openProject.test.ts`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit frontend provider plumbing**

```bash
git add src/lib/providers.ts src/components/shared/Icon.tsx src/store/tabsSlice.ts src/store/tabsSlice.test.ts src/store/sessionsSlice.test.ts src/lib/windowMode.ts src/lib/windowMode.test.ts src/lib/openProject.test.ts
git commit -m "feat(desktop): add OpenCode provider to session UI"
```

---

### Task 5: OpenCode model settings and selection UI

**Files:**
- Modify: `DesktopApp/src/store/settingsSlice.ts`
- Modify: `DesktopApp/src/store/settingsSlice.test.ts`
- Modify: `DesktopApp/src/store/index.ts`
- Modify: persistence tests in `DesktopApp/src/store/`
- Modify: `DesktopApp/src/lib/tauri.ts`
- Modify: `DesktopApp/src/components/terminal/TerminalView.tsx`
- Modify: `DesktopApp/src/components/dialogs/SettingsDialog.tsx`
- Modify: `DesktopApp/src/components/history/HistoryHeader.tsx`

**Interfaces:**
- Consumes: Tauri command `detect_opencode_models` and provider prompt dispatch from Task 3.
- Produces: `opencodeModelId`, `opencodeTitleGenModelId`, `opencodeCustomModels`, and their Zustand actions.

- [ ] **Step 1: Write failing settings slice tests**

Add a suite parallel to the Codex suite:

```ts
describe('settingsSlice OpenCode models', () => {
  beforeEach(() => {
    useStore.setState({ opencodeModelId: '', opencodeTitleGenModelId: '', opencodeCustomModels: [] });
  });

  it('trims and deduplicates custom models', () => {
    useStore.getState().addOpencodeCustomModel('  anthropic/claude-sonnet-4-5  ');
    useStore.getState().addOpencodeCustomModel('anthropic/claude-sonnet-4-5');
    expect(useStore.getState().opencodeCustomModels).toEqual(['anthropic/claude-sonnet-4-5']);
  });

  it('resets both selections when their custom model is removed', () => {
    useStore.getState().addOpencodeCustomModel('openai/gpt-5.4');
    useStore.getState().setOpencodeModel('openai/gpt-5.4');
    useStore.getState().setOpencodeTitleGenModel('openai/gpt-5.4');
    useStore.getState().removeOpencodeCustomModel('openai/gpt-5.4');
    expect(useStore.getState().opencodeModelId).toBe('');
    expect(useStore.getState().opencodeTitleGenModelId).toBe('');
  });
});
```

Extend persistence tests to hydrate and serialize all three fields.

- [ ] **Step 2: Run settings tests and verify failure**

Run: `npm test -- src/store/settingsSlice.test.ts`

Expected: FAIL because OpenCode settings and actions do not exist.

- [ ] **Step 3: Implement Zustand state and persistence**

Add these state fields and actions:

```ts
opencodeModelId: string;
opencodeTitleGenModelId: string;
opencodeCustomModels: string[];
setOpencodeModel: (modelId: string) => void;
setOpencodeTitleGenModel: (modelId: string) => void;
addOpencodeCustomModel: (modelId: string) => void;
removeOpencodeCustomModel: (modelId: string) => void;
```

Update `Persisted`, `PERSISTED_KEYS`, `pickPersistedFields`, JSON serialization/deserialization, and `applyPersistedToState`. Use empty strings and an empty array as defaults.

- [ ] **Step 4: Add the IPC wrapper and terminal model selection**

Add:

```ts
detectOpencodeModels: () => invoke<string[]>('detect_opencode_models'),
```

In `TerminalView`, select a model only for fresh sessions:

```ts
...(agentProvider === 'opencode' && !isResume && opencodeModelId
  ? { model: opencodeModelId }
  : {}),
```

Include `opencodeModelId` in the component selector and retain the existing PTY effect dependency strategy.

- [ ] **Step 5: Add OpenCode title-model controls**

In the CLI settings title-model section, load OpenCode models once and render `Auto (konfiguracja OpenCode)` plus detected/custom values when `enabledProviders.includes('opencode')`.

In `HistoryHeader`, choose the title model explicitly:

```ts
const modelCli = provider === 'codex'
  ? (codexTitleGenModelId || undefined)
  : provider === 'opencode'
    ? (opencodeTitleGenModelId || undefined)
    : (getCliModelString(titleGenModelId, customModels) ?? undefined);
```

- [ ] **Step 6: Add a reusable plain-string model section**

Extract the current Codex radio/custom-list body into a local `PlainModelSection` inside `SettingsDialog.tsx` with these props:

```ts
type PlainModelSectionProps = {
  label: string;
  description: string;
  radioName: string;
  autoLabel: string;
  selected: string;
  detected: string[];
  custom: string[];
  onSelect: (model: string) => void;
  onAdd: (model: string) => void;
  onRemove: (model: string) => void;
};
```

Render it for Codex and OpenCode. Keep one provider-specific `useEffect` per detection command. The OpenCode section copy is:

- label: `OpenCode`;
- description: `Model używany przy tworzeniu nowych sesji OpenCode. „Auto” pozostawia wybór konfiguracji OpenCode.`;
- auto label: `Auto (konfiguracja OpenCode)`;
- placeholder: `np. anthropic/claude-sonnet-4-5`.

- [ ] **Step 7: Run tests and type checking**

Run: `npm test -- src/store/settingsSlice.test.ts`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 8: Commit settings and models**

```bash
git add src/store/settingsSlice.ts src/store/settingsSlice.test.ts src/store/index.ts src/lib/tauri.ts src/components/terminal/TerminalView.tsx src/components/dialogs/SettingsDialog.tsx src/components/history/HistoryHeader.tsx
git commit -m "feat(desktop): add OpenCode model settings"
```

---

### Task 6: Mutable live-history synchronization in React

**Files:**
- Create: `DesktopApp/src/lib/historySync.ts`
- Create: `DesktopApp/src/lib/historySync.test.ts`
- Modify: `DesktopApp/src/lib/tauri.ts`
- Modify: `DesktopApp/src/components/history/HistoryView.tsx`
- Modify: `DesktopApp/src/components/history/HistoryView.test.tsx`

**Interfaces:**
- Consumes: backend event `session:<id>:sync` and `tauri.readSessionHistory`.
- Produces: `mergeHistoryWindow(current: HistoryBlock[], incoming: HistoryBlock[]) -> HistoryBlock[]` and `tauri.onSessionSync(sessionId, cb)`.

- [ ] **Step 1: Write failing merge tests**

Cover replacement, append, retention of loaded older blocks, no-overlap append, and empty incoming history:

```ts
it('replaces the overlapping tail and keeps loaded older blocks', () => {
  const current = [text('old', 'old'), text('stream', 'partial')];
  const incoming = [text('stream', 'complete'), text('next', 'done')];
  expect(mergeHistoryWindow(current, incoming)).toEqual([
    text('old', 'old'),
    text('stream', 'complete'),
    text('next', 'done'),
  ]);
});
```

- [ ] **Step 2: Run the helper test and verify failure**

Run: `npm test -- src/lib/historySync.test.ts`

Expected: FAIL because `mergeHistoryWindow` does not exist.

- [ ] **Step 3: Implement stable-tail merging**

Use the first incoming UUID that already exists in `current` as the replacement boundary:

```ts
export function mergeHistoryWindow(current: HistoryBlock[], incoming: HistoryBlock[]): HistoryBlock[] {
  if (incoming.length === 0) return current;
  const currentIndex = new Map(current.map((block, index) => [block.uuid, index]));
  const overlap = incoming.find(block => currentIndex.has(block.uuid));
  if (!overlap) return [...current, ...incoming];
  return [...current.slice(0, currentIndex.get(overlap.uuid)!), ...incoming];
}
```

- [ ] **Step 4: Add the typed Tauri listener and failing HistoryView test**

Add:

```ts
onSessionSync: (sessionId: string, cb: () => void): Promise<UnlistenFn> =>
  listen(`session:${sessionId}:sync`, () => cb()),
```

In `HistoryView.test.tsx`, capture the sync callback, mock a second history response containing an updated `b0` and new `b1`, trigger the callback twice inside 150 ms, advance fake timers, and assert `readSessionHistory` was called only once for the burst after initial loading.

- [ ] **Step 5: Implement debounced synchronization in HistoryView**

Subscribe only when `provider === 'opencode'`. Use a 150 ms timer and the current project/session/provider values. On refresh:

```ts
const latest = await tauri.readSessionHistory(projectId, sessionId, provider);
setData(previous => previous ? {
  meta: latest.meta,
  blocks: mergeHistoryWindow(previous.blocks, latest.blocks),
  hasMoreBefore: previous.hasMoreBefore || latest.hasMoreBefore,
} : latest);
renameTab(tabId, latest.meta.title);
```

Clear the timer and unsubscribe during effect cleanup. Keep existing append, activity, and title listeners for Claude and Codex.

- [ ] **Step 6: Run focused frontend tests**

Run: `npm test -- src/lib/historySync.test.ts src/components/history/HistoryView.test.tsx`

Expected: PASS.

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit history synchronization**

```bash
git add src/lib/historySync.ts src/lib/historySync.test.ts src/lib/tauri.ts src/components/history/HistoryView.tsx src/components/history/HistoryView.test.tsx
git commit -m "feat(desktop): synchronize mutable OpenCode history"
```

---

### Task 7: Unsupported-feature boundaries and project documentation

**Files:**
- Modify: `DesktopApp/src/components/right/UsageSection.tsx`
- Modify: `DesktopApp/src/components/right/UsageSection.test.tsx`
- Modify: `DesktopApp/CLAUDE.md`

**Interfaces:**
- Consumes: session tabs carrying `provider: 'opencode'`.
- Produces: honest unsupported-state UI and durable provider documentation.

- [ ] **Step 1: Write failing usage-boundary tests**

Add an active OpenCode session tab fixture. Assert that:

- the usage tab displays `Brak danych o zużyciu dla OpenCode`;
- the limits tab displays `Brak danych o limitach dla OpenCode`;
- neither `tauri.sessionUsage` nor `tauri.providerLimits` is called for OpenCode.

- [ ] **Step 2: Run the UsageSection test and verify failure**

Run: `npm test -- src/components/right/UsageSection.test.tsx`

Expected: FAIL because the component currently invokes Claude-oriented usage commands for every provider.

- [ ] **Step 3: Implement explicit OpenCode unsupported states**

Derive `const supportsUsage = provider !== 'opencode'`. Guard both effects with it and render the two Polish messages above in their respective tabs. Preserve Claude and Codex limit behavior.

- [ ] **Step 4: Update project documentation**

In the `Providers` section of `DesktopApp/CLAUDE.md`, document:

- `Provider` now serializes `claude | codex | opencode`;
- OpenCode 1.18.31 uses read-only `opencode.db` discovery filtered by `session.directory`;
- child sessions are excluded from the top-level list;
- OpenCode history is mutable and uses DB/WAL-triggered `session:<id>:sync` rather than append offsets;
- OpenCode model IDs remain opaque `provider/model` strings;
- remote bridge, usage/cost, limits, and OpenCode subagent presentation remain unsupported.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- src/components/right/UsageSection.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit boundaries and documentation**

```bash
git add src/components/right/UsageSection.tsx src/components/right/UsageSection.test.tsx CLAUDE.md
git commit -m "docs(desktop): document OpenCode provider boundaries"
```

---

### Task 8: Full verification and manual smoke test

**Files:**
- Modify only files required by failures attributable to the OpenCode integration.

**Interfaces:**
- Consumes: completed Tasks 1–7.
- Produces: a verified end-to-end OpenCode provider implementation.

- [ ] **Step 1: Verify generated contracts and repository formatting**

Run: `npm run test:rust`

Expected: PASS and `src/types/Provider.ts` contains `"opencode"`.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 2: Run the complete frontend suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run TypeScript validation**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 4: Perform a local read-only session smoke test**

Start the app with `npm run tauri dev` and verify:

1. Settings → CLI shows OpenCode as available when `opencode` is on the selected shell PATH.
2. Settings → Modele lists `Auto`, detected `provider/model` entries, and accepts a custom entry.
3. Enabling Claude, Codex, and OpenCode shows all three choices in the new-session picker.
4. Starting OpenCode opens its TUI in the selected project.
5. Sending one harmless prompt creates a linked `ses_...` session and replaces the `new-...` tab title.
6. Closing and reopening the session in history mode shows user, assistant, reasoning, and tool blocks without duplicates.
7. Resuming the session launches `opencode --session <id>`.
8. OpenCode export produces JSON and Markdown through the existing UI.
9. The Usage panel shows the two explicit unsupported messages.
10. Claude and Codex still start, resume, list, and open history.

Do not modify, delete, or rename OpenCode user sessions during the smoke test except for the temporary title-generation session created and cleaned by the feature itself.

- [ ] **Step 5: Inspect the final change set**

Run: `git status --short`

Expected: only pre-existing unrelated user files may remain untracked; implementation files are committed.

Run: `git log --oneline -10`

Expected: one conventional commit for each completed task and no co-author trailers.

- [ ] **Step 6: Commit verification-only fixes if needed**

If verification required code changes, stage only those explicit files and commit:

```bash
git commit -m "fix(desktop): complete OpenCode provider verification"
```

If no fixes were required, do not create an empty commit.
