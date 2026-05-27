# Session usage & cost — design

Date: 2026-05-27
Status: approved (pending spec review)

## Goal

Show, per coding session, how much it consumed in two dimensions:

1. **Tokens** — raw counts (input / output / cache write / cache read).
2. **Real cost** — hypothetical USD as if billed via the Anthropic API (the user runs
   Claude Code on a subscription, so this is an estimate for ROI/awareness, not an actual bill).

Surfaced as a new **"Zużycie"** section pinned to the bottom of the right panel, below the
Git section, showing two lines: **active session** and **project total**.

## Why this is feasible

Every `assistant` line in a Claude Code session `*.jsonl` carries `message.usage`
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`)
and `message.model`. Tokens are summed directly; cost is tokens × a built-in price table.

## Key correctness concerns

- **Cache tokens are priced separately.** `input_tokens` already excludes cache buckets.
  Cost = `input·p_in + output·p_out + cache_write·p_write + cache_read·p_read`.
  Naive `(input+output)·price` over-counts heavily on long sessions (cache_read dominates).
- **De-duplication.** Claude Code can write multiple `assistant` lines per `requestId`
  (streaming/iterations — see `iterations[]` in real records). Dedup by `message.id`
  (fallback `requestId`) to avoid double counting.
- **Per-message model.** Model can vary within a session (fallback, subagents). Apply the
  price table per message by its `model`, not once per session.
- **Unknown model.** A model with no price entry contributes 0 cost but is reported in
  `unknown_models` so the UI can signal "tokens counted, price unknown".

## Chosen decisions

| Decision | Choice |
|---|---|
| UI placement | New "Zużycie" section, bottom of right panel, under Git |
| Context | Active session **and** project total (two lines) |
| Pricing source | Built-in table in Rust code |
| Freshness | Live for active session (via watcher); project total on tab/project switch, window focus, manual refresh |
| Architecture | Backend-aggregated, event-driven (approach A) |

## Data model (Rust `domain/usage.rs`, exported via ts-rs)

```rust
struct TokenTotals { input: u64, output: u64, cache_write: u64, cache_read: u64 }   // dim 1
struct ModelUsage  { model: String, tokens: TokenTotals, cost_usd: f64 }            // per-model breakdown
struct UsageSummary {
    tokens: TokenTotals,           // summed across models
    cost_usd: f64,                 // dim 2
    by_model: Vec<ModelUsage>,     // for tooltip / expand
    unknown_models: Vec<String>,   // models with no price entry
}
```

`UsageSummary` is reused for both active session and project total → one rendering component.
All derive `Serialize, Deserialize, TS` with `#[ts(export, export_to = "../../src/types/")]`
and `#[serde(rename_all = "camelCase")]`, matching existing `domain/session.rs`.

## Backend

### `sessions/usage.rs`
- `extract_usage(line: &Value) -> Option<(model: String, dedup_key: String, TokenTotals)>`
  — reads `message.model` + `message.usage`; `dedup_key = message.id` (fallback `requestId`).
- `struct UsageAccumulator { seen: HashSet<String>, by_model: HashMap<String, TokenTotals> }`
  with `add_line(&Value)` (skips already-seen keys) and `finalize(&PriceTable) -> UsageSummary`.

### `sessions/pricing.rs`
- `struct ModelPrice { input, output, cache_write, cache_read }` — USD per 1M tokens.
- `price_for(model: &str) -> Option<ModelPrice>` — built-in `match`/prefix lookup for
  `claude-opus-4-*`, `claude-sonnet-4-*`, `claude-haiku-4-*` (match by prefix/contains so it
  survives date suffixes). Unknown → `None`.
- **Cost function** (the meaningful business-logic decision, implemented during the plan as a
  learning-mode contribution): how to weight cache_write (1.25× vs 2× depending on
  `ephemeral_5m`/`ephemeral_1h`) and how to treat unknown models. Function signature with a
  TODO will be prepared so the choice is explicit.

### `commands/usage.rs`
- `session_usage(project_id, session_id) -> UsageSummary` — full scan of one file.
- `project_usage(project_id) -> UsageSummary` — scan all `*.jsonl`; result cached.
- Registered in `lib.rs`.

### `AppState`
- New field `project_usage_cache: Mutex<HashMap<i64, UsageSummary>>` (mirrors `shell_env` pattern).
- Invalidated when the watcher detects a change to a session file belonging to that project.

## Watcher — live active session

- `OpenSession` gains `usage: UsageAccumulator`, initialized by a full scan in `open()`.
- In `handle_change`, after processing the appended `tail`, accumulate usage from the new lines
  and emit the **absolute** running summary: `app.emit("session:{sid}:usage", &summary)`
  (parallel to the existing `session:{sid}:append`).
- `handle_change` also invalidates `project_usage_cache` for the changed file's project.
- Dedup-key set carried in `OpenSession` so totals stay correct across tail boundaries.

## IPC (`src/lib/tauri.ts`)

```ts
sessionUsage: (projectId, sessionId) => invoke<UsageSummary>('session_usage', { projectId, sessionId }),
projectUsage: (projectId)            => invoke<UsageSummary>('project_usage', { projectId }),
onSessionUsage: (sessionId, cb)      => listen<UsageSummary>(`session:${sessionId}:usage`, e => cb(e.payload)),
```

## Frontend — `components/right/UsageSection.tsx`

- `RightPanel` relayout: `GitSection` keeps `flex-1`, `UsageSection` is `shrink-0` pinned at the
  bottom with a `border-t` separator.
- Context from active tab (like `GitSection`): `projectId` + optional `sessionId` (when the active
  tab is a session).
- **Active session**: `sessionUsage(...)` on mount/session change + `onSessionUsage` subscription
  (live). When active tab is not a session → line shows "—".
- **Project total**: `projectUsage(...)` on project change, on `window focus`, and on a refresh
  button (mirrors `GitSection`).
- Render: two lines "Sesja" / "Projekt", each with `Σ tokens` + `~$X.XX`. Tooltip/expand shows
  input/output/cache split and per-model breakdown. UI text in Polish; identifiers in English.
- A small TS formatter helper (`1.2M`, `$0.42`) — pure presentation, no pricing logic.

## Testing

- **Rust** `usage.rs`: dedup by `message.id`, correct summation of all four buckets, per-model split.
- **Rust** `pricing.rs`: known model computes cost; unknown → `unknown_models` + cost 0.
- Extend `tests/fixtures/sample.jsonl` with lines carrying `usage`.
- **Front**: light `UsageSection` test (renders two lines; no session → "—").
- `npm run lint` zero errors; run `cargo test` once so ts-rs materializes
  `src/types/UsageSummary.ts` et al.

## Out of scope (YAGNI)

- Editing prices in Settings UI (decided: built-in table only).
- Sidebar per-session cost badges and a global cost dashboard.
- Persisting historical cost snapshots in SQLite (computed on demand + cache is enough).
