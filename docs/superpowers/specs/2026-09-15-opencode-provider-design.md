# OpenCode Provider Design

**Date:** 2026-09-15

## Goal

Add OpenCode as the third desktop AI CLI provider next to Claude Code and
Codex. The integration covers provider selection, starting and resuming
sessions, project-scoped session discovery, history, live history updates,
activity, export, model selection, and title generation.

The first version does not add OpenCode sessions to AbeonCloud, usage limits,
cost tracking, or OpenCode subagent presentation.

## Supported Version

The implementation targets the stable OpenCode 1.18.31 SQLite schema. Schema
validation must fail with a clear error when the expected `session`, `message`,
or `part` tables and required columns are absent. A schema mismatch must not
break Claude or Codex session loading.

## Architecture

The existing `domain::Provider` seam gains an `Opencode` variant serialized as
`opencode`. OpenCode participates in the same provider-aware frontend and IPC
contracts as Claude and Codex.

The integration is hybrid:

- the OpenCode CLI starts and resumes agents, lists configured models, and
  generates ad-hoc text such as session titles;
- the OpenCode SQLite database supplies session metadata, history, and
  activity;
- the existing filesystem watcher observes SQLite database and WAL changes and
  tells the frontend when an open history needs synchronization.

This avoids a managed `opencode serve` process and avoids spawning a CLI process
for every sidebar refresh.

## Provider and Model Identity

`opencode` is the AbeonCode session provider. It must not be confused with an
OpenCode model provider such as `anthropic`, `openai`, or `opencode` itself.

OpenCode model values are opaque strings in the documented
`provider_id/model_id` format. AbeonCode passes them through without splitting
or normalizing them. An empty model setting means that OpenCode chooses its own
configured default.

The frontend provider registry contains:

- label: `OpenCode`;
- provider value: `opencode`;
- an OpenCode-specific icon;
- availability reported by `detect_providers` using the `opencode` binary.

## CLI Commands

The PTY command builder uses these forms:

- fresh session: `opencode`;
- resumed session: `opencode --session <session-id>`;
- selected model on a fresh session: `opencode --model <provider/model>`;
- skipped permissions: `opencode --auto`.

OpenCode cannot accept a caller-assigned ID for a fresh interactive session.
Fresh tabs therefore use the existing `new-<uuid>` placeholder flow used by
Codex. The frontend links the placeholder to the first newly discovered session
whose provider is `opencode`.

Session IDs and model values pass through the existing validation boundary
before they reach the shell command.

## Data Location and Database Access

The reader resolves `opencode.db` from the OpenCode data directory. Resolution
uses, in order:

1. `XDG_DATA_HOME/opencode/opencode.db` when `XDG_DATA_HOME` is set;
2. the platform data directory returned by `dirs::data_dir()`;
3. `~/.local/share/opencode/opencode.db` as a Linux fallback.

If the database does not exist, OpenCode contributes no sessions and does not
produce an error during ordinary sidebar loading.

Every connection is opened read-only. It uses a short busy timeout so a
concurrent OpenCode transaction does not immediately fail, but AbeonCode never
checkpoints, migrates, or writes to the OpenCode database.

Schema validation checks the required tables and columns before queries run.
The reader exposes focused functions for listing sessions, counting sessions,
reading history, retrieving the first user prompt, reading the current session
revision, and computing activity.

## Session Discovery

The project session query selects rows from `session` where:

- `directory` exactly equals the project path;
- `parent_id IS NULL`, so OpenCode child/subagent sessions are not shown as
  top-level AbeonCode sessions;
- archived sessions remain discoverable unless the existing AbeonCode product
  behavior later adds a shared archive filter.

Rows are ordered by `time_updated DESC`. `SessionMeta` maps as follows:

- `id` from `session.id`;
- `title` from `session.title`, with the existing AbeonCode title override
  applied afterward;
- `message_count` from the number of messages belonging to the session;
- `last_modified` from `session.time_updated`;
- `cwd` from `session.directory`;
- `git_branch` as `None`, because the supported schema has no session branch;
- `provider` as `opencode`;
- subagent counters as zero in this version.

Claude, Codex, and OpenCode results are merged and paginated after sorting by
`last_modified`. Session discovery runs regardless of whether OpenCode is
currently enabled, matching the existing Codex behavior for historical data.

## History Mapping

History is read from `message` and `part` using deterministic ordering by
creation time and ID. JSON stored in each row is parsed defensively; an unknown
part type is ignored instead of failing the whole session.

The shared history mapping is:

| OpenCode value | AbeonCode block |
| --- | --- |
| user message + `text` part | `UserText` |
| assistant message + `text` part | `AssistantText` |
| assistant `reasoning` part | `AssistantThinking` |
| `tool` part in any state | `ToolUse` |
| completed `tool` part | `ToolResult` with `is_error = false` |
| failed/error `tool` part | `ToolResult` with `is_error = true` |
| `file` part | `Attachment` |

Tool input comes from `state.input`, is kept as `raw_input`, and is summarized
with the existing shared input summarizer. Tool output comes from
`state.output`; a failed tool uses `state.error` when no output exists.

Stable block UUIDs are derived from OpenCode message and part IDs. A tool result
uses a distinct suffix from its tool-use block. This allows the frontend to
replace a streaming text block and append a newly completed tool result without
duplicates.

Part timestamps use their embedded start/end timestamps when present and fall
back to the database row or parent message creation time. Pagination continues
to use the shared `before_uuid` contract over the flattened block sequence.

The existing export command renders the mapped `SessionHistory` as JSON or
Markdown, so OpenCode requires no separate export UI.

## Activity

OpenCode activity is computed from the session revision and its most recent
meaningful message/part, using the existing AbeonCode timing thresholds:

- a very recent database update is `Running`;
- a recent user text or an active tool is `Running`;
- a tool that remains pending or running past the tool-stall threshold is
  `WaitingTool`;
- a completed assistant response or tool is `WaitingUser`;
- a failed tool is `WaitingUser`;
- stale waiting states decay to `Idle`, and the hard age cap always yields
  `Idle`.

Unknown or malformed rows do not make a session appear active.

## Live History Synchronization

File-oriented providers append immutable JSONL records, but OpenCode updates
existing SQLite rows while streaming. OpenCode therefore does not use the
existing byte-offset append reader.

Opening an OpenCode history registers a database-backed watcher entry containing
the session ID and last observed `session.time_updated`. The shared notify
watcher observes the directory containing `opencode.db`. Changes to
`opencode.db` or `opencode.db-wal` cause these steps:

1. read the current revision for each open OpenCode session;
2. ignore sessions whose revision did not change;
3. emit a provider-neutral session synchronization event for changed sessions;
4. emit the recomputed activity and native title when they changed.

The frontend debounces synchronization events, reloads the newest history
window, and merges it into the current view by block UUID. Existing blocks are
replaced, new blocks are appended, and already loaded older blocks are retained.
This supports streaming text and mutable tool state without duplicate blocks.

Closing the history removes the watcher entry exactly like the existing
providers. Multiple open OpenCode histories share the same filesystem watcher.

## Settings and Models

The persisted settings shape gains:

- `opencodeModelId`;
- `opencodeTitleGenModelId`;
- `opencodeCustomModels`.

The CLI settings tab lists OpenCode with availability detection. The Models tab
shows an OpenCode section only when the provider is enabled. It offers `Auto`,
models detected by `opencode models`, and manually entered model IDs.

Model detection runs the located OpenCode binary with the environment loaded
from the user's selected shell. Stdout is parsed as one model ID per non-empty
line, deduplicated while preserving order. A command failure returns an empty
detected list and does not remove custom models.

Fresh OpenCode PTYs receive `--model` only when `opencodeModelId` is non-empty.
Resumed sessions do not receive a model override.

## Title Generation

OpenCode's stored native title is used during discovery and placeholder linking.
The existing manual title-generation action also supports OpenCode.

The provider prompt runner starts:

`opencode run --format json [--model <provider/model>] <prompt>`

from a temporary directory. It parses JSONL output to obtain the assistant's
final text and the temporary session ID. Once the response is captured, it runs
`opencode session delete <session-id>`. Cleanup is also attempted after errors
whenever the session ID is known.

The prompt runner has a bounded timeout, kills the child on timeout, and returns
a concise error containing stderr without exposing credentials. Unit tests use
captured JSONL fixtures and never invoke a real model.

## Frontend Integration

All provider-aware surfaces accept `opencode`:

- provider picker;
- settings and model sections;
- sidebar session icon;
- terminal spawn and resume;
- tab persistence and restoration;
- detached session/group windows;
- history and export;
- title generation;
- fresh-session placeholder linking.

Provider parsing uses the shared `isProvider` guard. Detached-window query
parsing must use this guard rather than a Codex-only comparison.

OpenCode sessions report zero subagents, so the existing subagent badge and
viewer stay hidden. Cloud/remote dispatch remains limited to its current
providers and must reject or ignore OpenCode rather than silently treating it
as Claude.

## Error Handling

- Missing CLI: provider detection reports unavailable; no spawn is attempted by
  the settings UI.
- Missing database: listing and counting return empty results.
- Busy database: read operations wait for the configured busy timeout and then
  return a scoped OpenCode error.
- Unsupported schema: history/listing returns a clear compatibility error while
  other providers continue to work.
- Malformed JSON row: the affected part is skipped; valid history remains
  available.
- Model detection failure: detected models are empty; custom entries remain.
- Watcher read failure: no partial event is emitted; the normal ten-second
  sidebar refresh remains a recovery path.
- Temporary title session cleanup failure: the generated title still succeeds,
  and cleanup failure is logged without replacing the user-facing result.

## Testing

Rust tests use temporary SQLite databases with the supported tables and
synthetic rows. They cover:

- schema validation and missing-database behavior;
- project filtering and exclusion of child sessions;
- merged ordering and pagination;
- every supported history part mapping;
- malformed and unknown parts;
- stable block IDs and history pagination;
- activity transitions and decay;
- command construction for fresh/resumed/model/auto modes;
- OpenCode model-output and title-output parsing;
- watcher revision filtering.

Frontend tests cover:

- provider validation and restored tab sanitization;
- provider picker behavior with OpenCode as the only or one of several enabled
  providers;
- placeholder session linking by provider;
- settings persistence and model selection;
- detached-window round trips;
- live history merge with replacements and appends;
- provider icon rendering.

Final verification runs `npm test`, `npm run lint`, and `npm run test:rust` from
`DesktopApp/`.

## Documentation

`DesktopApp/CLAUDE.md` will document the third provider, the OpenCode SQLite
reader, the mutable-history synchronization path, model identifier semantics,
and the first-version limits.
