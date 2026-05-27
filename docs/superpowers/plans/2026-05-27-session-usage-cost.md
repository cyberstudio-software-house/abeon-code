# Session Usage & Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-session and per-project token usage and hypothetical API cost (USD) in a new "Zużycie" section pinned to the bottom of the right panel.

**Architecture:** Backend-aggregated, event-driven. Rust scans session `*.jsonl` files, sums the four token buckets de-duplicated by `message.id`, and computes cost from a built-in price table. The active session updates live via a new `session:{sid}:usage` watcher event; the project total is computed on demand and cached with mtime-based validation. The frontend only renders the precomputed `UsageSummary`.

**Tech Stack:** Rust (Tauri 2, serde_json, ts-rs), React 19 + Zustand + Tailwind, Vitest.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src-tauri/src/sessions/pricing.rs` | Built-in price table; `price_for(model)` | Create |
| `src-tauri/src/domain/usage.rs` | ts-rs-exported types: `TokenTotals`, `ModelUsage`, `UsageSummary` | Create |
| `src-tauri/src/sessions/usage.rs` | `RawTokens`, `extract_usage`, `UsageAccumulator`, `cost_of` | Create |
| `src-tauri/src/commands/usage.rs` | `session_usage`, `project_usage` commands | Create |
| `src-tauri/src/sessions/mod.rs` | register `pricing`, `usage` modules | Modify |
| `src-tauri/src/domain/mod.rs` | register `usage` module | Modify |
| `src-tauri/src/commands/mod.rs` | register `usage` module | Modify |
| `src-tauri/src/state.rs` | add `project_usage_cache` field | Modify |
| `src-tauri/src/sessions/watcher.rs` | track running usage per open session, emit `:usage` | Modify |
| `src-tauri/src/lib.rs` | register `session_usage`, `project_usage` | Modify |
| `src/lib/tauri.ts` | `sessionUsage`, `projectUsage`, `onSessionUsage` wrappers | Modify |
| `src/lib/formatUsage.ts` | `formatTokens`, `formatCost` presentation helpers | Create |
| `src/components/right/UsageSection.tsx` | render two-line usage section | Create |
| `src/components/right/RightPanel.tsx` | relayout: Git flex-1, Usage pinned bottom | Modify |
| `src/components/right/UsageSection.test.tsx` | render test | Create |

---

## Task 1: Price table (`sessions/pricing.rs`)

**Files:**
- Create: `src-tauri/src/sessions/pricing.rs`
- Modify: `src-tauri/src/sessions/mod.rs`

- [ ] **Step 1: Register the module**

Edit `src-tauri/src/sessions/mod.rs` to add `pub mod pricing;` after `pub mod parser;`:

```rust
pub mod activity;
pub mod encoding;
pub mod parser;
pub mod pricing;
pub mod reader;
pub mod watcher;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/sessions/pricing.rs`:

```rust
/// USD per 1,000,000 tokens, per bucket.
#[derive(Debug, Clone, Copy)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

/// Built-in price table. Matched by substring so date/point suffixes
/// (e.g. `claude-opus-4-7`) still resolve. Unknown model => `None`.
pub fn price_for(model: &str) -> Option<ModelPrice> {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        Some(ModelPrice { input: 15.0, output: 75.0, cache_write_5m: 18.75, cache_write_1h: 30.0, cache_read: 1.5 })
    } else if m.contains("sonnet") {
        Some(ModelPrice { input: 3.0, output: 15.0, cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.3 })
    } else if m.contains("haiku") {
        Some(ModelPrice { input: 1.0, output: 5.0, cache_write_5m: 1.25, cache_write_1h: 2.0, cache_read: 0.1 })
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_opus_with_date_suffix() {
        let p = price_for("claude-opus-4-7").unwrap();
        assert_eq!(p.input, 15.0);
        assert_eq!(p.output, 75.0);
    }

    #[test]
    fn resolves_sonnet_and_haiku() {
        assert_eq!(price_for("claude-sonnet-4-6").unwrap().input, 3.0);
        assert_eq!(price_for("claude-haiku-4-5-20251001").unwrap().input, 1.0);
    }

    #[test]
    fn unknown_model_is_none() {
        assert!(price_for("gpt-4o").is_none());
        assert!(price_for("").is_none());
    }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm run test:rust -- pricing`
Expected: 3 passed (`resolves_opus_with_date_suffix`, `resolves_sonnet_and_haiku`, `unknown_model_is_none`).

> Note: this module is data + a pure lookup, so test-first here means writing the table and tests together; the tests assert the table is correct.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sessions/pricing.rs src-tauri/src/sessions/mod.rs
git commit -m "feat(usage): add built-in model price table"
```

---

## Task 2: Usage domain types (`domain/usage.rs`)

**Files:**
- Create: `src-tauri/src/domain/usage.rs`
- Modify: `src-tauri/src/domain/mod.rs`

- [ ] **Step 1: Create the types**

Create `src-tauri/src/domain/usage.rs`:

```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Token counts (dimension 1). Cache write collapses 5m+1h for display.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
}

/// Per-model breakdown (models carry different prices).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub tokens: TokenTotals,
    pub cost_usd: f64,
}

/// Aggregate usage for a session or a whole project (dimension 1 + 2).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    pub unknown_models: Vec<String>,
}
```

- [ ] **Step 2: Register the module**

Edit `src-tauri/src/domain/mod.rs`. Add `pub mod usage;` to the module list and `pub use usage::*;` to the re-exports:

```rust
pub mod project;
pub mod action;
pub mod session;
pub mod git;
pub mod shell;
pub mod editor;
pub mod usage;

pub use project::*;
pub use action::*;
pub use session::*;
pub use git::*;
pub use shell::*;
pub use editor::*;
pub use usage::*;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: builds without errors (TS files are NOT generated by build — that happens in Task 6 via `cargo test`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/domain/usage.rs src-tauri/src/domain/mod.rs
git commit -m "feat(usage): add UsageSummary domain types"
```

---

## Task 3: Usage aggregation (`sessions/usage.rs`)

**Files:**
- Create: `src-tauri/src/sessions/usage.rs`
- Modify: `src-tauri/src/sessions/mod.rs`

- [ ] **Step 1: Register the module**

Edit `src-tauri/src/sessions/mod.rs` to add `pub mod usage;`:

```rust
pub mod activity;
pub mod encoding;
pub mod parser;
pub mod pricing;
pub mod reader;
pub mod usage;
pub mod watcher;
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/sessions/usage.rs` with everything EXCEPT the body of `cost_of` (left as a learning-mode contribution in Step 4):

```rust
use std::collections::{HashMap, HashSet};
use serde_json::Value;
use crate::domain::{ModelUsage, TokenTotals, UsageSummary};
use crate::sessions::pricing::{price_for, ModelPrice};

/// Raw per-model tally with the 5m/1h cache split kept for accurate pricing.
#[derive(Debug, Clone, Copy, Default)]
struct RawTokens {
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
}

impl RawTokens {
    fn add(&mut self, o: &RawTokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_write_5m += o.cache_write_5m;
        self.cache_write_1h += o.cache_write_1h;
        self.cache_read += o.cache_read;
    }

    fn display(&self) -> TokenTotals {
        TokenTotals {
            input: self.input,
            output: self.output,
            cache_write: self.cache_write_5m + self.cache_write_1h,
            cache_read: self.cache_read,
        }
    }
}

fn u64_at(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

/// Reads `message.model` + `message.usage` from one parsed JSONL line.
/// Returns `(model, dedup_key, tokens)` or `None` for non-usage lines.
/// `dedup_key` prefers `message.id`, falls back to top-level `requestId`, then `uuid`.
pub fn extract_usage(line: &Value) -> Option<(String, String, RawTokens)> {
    let msg = line.get("message")?;
    let usage = msg.get("usage")?;
    let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
    let dedup_key = msg.get("id").and_then(|x| x.as_str())
        .or_else(|| line.get("requestId").and_then(|x| x.as_str()))
        .or_else(|| line.get("uuid").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();

    let cache = usage.get("cache_creation");
    let (cw5m, cw1h) = match cache {
        Some(c) => (u64_at(c, "ephemeral_5m_input_tokens"), u64_at(c, "ephemeral_1h_input_tokens")),
        // Older records without the breakdown: attribute the lump to the 5m bucket.
        None => (u64_at(usage, "cache_creation_input_tokens"), 0),
    };

    let tokens = RawTokens {
        input: u64_at(usage, "input_tokens"),
        output: u64_at(usage, "output_tokens"),
        cache_write_5m: cw5m,
        cache_write_1h: cw1h,
        cache_read: u64_at(usage, "cache_read_input_tokens"),
    };
    Some((model, dedup_key, tokens))
}

/// Accumulates usage across many lines, de-duplicating repeated API responses.
#[derive(Default)]
pub struct UsageAccumulator {
    seen: HashSet<String>,
    by_model: HashMap<String, RawTokens>,
}

impl UsageAccumulator {
    pub fn add_line(&mut self, line: &Value) {
        if let Some((model, key, tokens)) = extract_usage(line) {
            if !key.is_empty() && !self.seen.insert(key) {
                return; // already counted this API response
            }
            self.by_model.entry(model).or_default().add(&tokens);
        }
    }

    pub fn finalize(&self) -> UsageSummary {
        let mut total = RawTokens::default();
        let mut by_model = Vec::new();
        let mut unknown_models = Vec::new();
        let mut cost_total = 0.0;

        for (model, raw) in &self.by_model {
            total.add(raw);
            let cost = match price_for(model) {
                Some(price) => cost_of(raw, &price),
                None => {
                    unknown_models.push(model.clone());
                    0.0
                }
            };
            cost_total += cost;
            by_model.push(ModelUsage { model: model.clone(), tokens: raw.display(), cost_usd: cost });
        }

        by_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
        unknown_models.sort();

        UsageSummary {
            tokens: total.display(),
            cost_usd: cost_total,
            by_model,
            unknown_models,
        }
    }
}

/// Cost in USD for one model's raw token tally given its price.
/// Each bucket priced separately; prices are USD per 1,000,000 tokens.
fn cost_of(t: &RawTokens, p: &ModelPrice) -> f64 {
    // IMPLEMENTED IN STEP 4 (learning-mode contribution).
    let _ = (t, p);
    0.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assistant(id: &str, model: &str, input: u64, output: u64, cw1h: u64, read: u64) -> Value {
        json!({
            "type": "assistant",
            "uuid": format!("uuid-{id}"),
            "requestId": format!("req-{id}"),
            "message": {
                "id": id,
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_read_input_tokens": read,
                    "cache_creation_input_tokens": cw1h,
                    "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": cw1h }
                }
            }
        })
    }

    #[test]
    fn extracts_buckets_and_splits_cache_write() {
        let (model, key, t) = extract_usage(&assistant("msg_1", "claude-opus-4-7", 100, 50, 200, 300)).unwrap();
        assert_eq!(model, "claude-opus-4-7");
        assert_eq!(key, "msg_1");
        assert_eq!(t.input, 100);
        assert_eq!(t.output, 50);
        assert_eq!(t.cache_write_1h, 200);
        assert_eq!(t.cache_write_5m, 0);
        assert_eq!(t.cache_read, 300);
    }

    #[test]
    fn non_usage_line_returns_none() {
        assert!(extract_usage(&json!({"type":"user","message":{"content":"hi"}})).is_none());
    }

    #[test]
    fn dedupes_by_message_id() {
        let mut acc = UsageAccumulator::default();
        let line = assistant("msg_1", "claude-opus-4-7", 100, 50, 0, 0);
        acc.add_line(&line);
        acc.add_line(&line); // duplicate API response, must not double count
        let s = acc.finalize();
        assert_eq!(s.tokens.input, 100);
        assert_eq!(s.tokens.output, 50);
    }

    #[test]
    fn sums_across_models_and_reports_unknown() {
        let mut acc = UsageAccumulator::default();
        acc.add_line(&assistant("a", "claude-opus-4-7", 100, 10, 0, 0));
        acc.add_line(&assistant("b", "claude-sonnet-4-6", 200, 20, 0, 0));
        acc.add_line(&assistant("c", "mystery-model", 1000, 1000, 0, 0));
        let s = acc.finalize();
        assert_eq!(s.tokens.input, 1300);
        assert_eq!(s.tokens.output, 1030);
        assert_eq!(s.by_model.len(), 3);
        assert_eq!(s.unknown_models, vec!["mystery-model".to_string()]);
    }

    #[test]
    fn computes_cost_per_bucket() {
        // 1M input + 1M output on opus => 15 + 75 = 90 USD; cache_read 1M => +1.5
        let mut acc = UsageAccumulator::default();
        acc.add_line(&assistant("x", "claude-opus-4-7", 1_000_000, 1_000_000, 0, 1_000_000));
        let s = acc.finalize();
        assert!((s.cost_usd - 91.5).abs() < 1e-6, "got {}", s.cost_usd);
    }

    #[test]
    fn cache_write_1h_priced_higher_than_input() {
        // 1M 1h-cache-write on opus => 30 USD
        let mut acc = UsageAccumulator::default();
        acc.add_line(&assistant("y", "claude-opus-4-7", 0, 0, 1_000_000, 0));
        let s = acc.finalize();
        assert!((s.cost_usd - 30.0).abs() < 1e-6, "got {}", s.cost_usd);
    }
}
```

- [ ] **Step 3: Run tests to verify the cost tests FAIL**

Run: `npm run test:rust -- usage`
Expected: `extracts_buckets_and_splits_cache_write`, `non_usage_line_returns_none`, `dedupes_by_message_id`, `sums_across_models_and_reports_unknown` PASS; `computes_cost_per_bucket` and `cache_write_1h_priced_higher_than_input` FAIL (cost is 0.0 because `cost_of` is a stub).

- [ ] **Step 4: Implement `cost_of` (LEARNING-MODE CONTRIBUTION)**

> **Learning opportunity — the executor pauses here for the user.** This is the one piece of genuine business logic: how to weight each token bucket. The cache split matters because 1h cache-write is 2× the input price while 5m is 1.25×, and cache-read is only 0.1×. Replace the stub body of `cost_of` so the two failing tests pass. Reference implementation (use this if not contributing manually):

```rust
fn cost_of(t: &RawTokens, p: &ModelPrice) -> f64 {
    let per = 1_000_000.0;
    (t.input as f64 * p.input
        + t.output as f64 * p.output
        + t.cache_write_5m as f64 * p.cache_write_5m
        + t.cache_write_1h as f64 * p.cache_write_1h
        + t.cache_read as f64 * p.cache_read) / per
}
```

Remove the `let _ = (t, p);` stub line when implementing.

- [ ] **Step 5: Run tests to verify all pass**

Run: `npm run test:rust -- usage`
Expected: all 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sessions/usage.rs src-tauri/src/sessions/mod.rs
git commit -m "feat(usage): aggregate session tokens and compute API cost"
```

---

## Task 4: Commands + AppState cache (`commands/usage.rs`)

**Files:**
- Create: `src-tauri/src/commands/usage.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the cache field to `AppState`**

Edit `src-tauri/src/state.rs`. Add the import and field, and initialize it.

Add to the struct (after `clipboard_images`):

```rust
    /// Cached project usage keyed by project_id: (max session-file mtime seen, summary).
    pub project_usage_cache: Mutex<HashMap<i64, (i64, crate::domain::UsageSummary)>>,
```

Add to `AppState::new` (after `clipboard_images: Mutex::new(HashMap::new()),`):

```rust
            project_usage_cache: Mutex::new(HashMap::new()),
```

(`HashMap`, `Mutex` are already imported in `state.rs`.)

- [ ] **Step 2: Register the command module**

Edit `src-tauri/src/commands/mod.rs` to add `pub mod usage;`:

```rust
pub mod projects;
pub mod sessions;
pub mod pty;
pub mod actions;
pub mod git;
pub mod settings;
pub mod activity;
pub mod usage;
```

- [ ] **Step 3: Write the commands**

Create `src-tauri/src/commands/usage.rs`:

```rust
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tauri::State;
use crate::domain::UsageSummary;
use crate::error::{AppError, AppResult};
use crate::sessions::usage::UsageAccumulator;
use crate::state::AppState;
use crate::db::projects_repo;

fn claude_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".claude").join("projects"))
}

fn mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Scans one session file and aggregates usage.
fn scan_file(path: &Path) -> UsageSummary {
    let mut acc = UsageAccumulator::default();
    if let Ok(file) = fs::File::open(path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                acc.add_line(&v);
            }
        }
    }
    acc.finalize()
}

#[tauri::command]
pub fn session_usage(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
) -> AppResult<UsageSummary> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = claude_root()?.join(&proj.claude_dir);
    let path = dir.join(format!("{session_id}.jsonl"));
    Ok(scan_file(&path))
}

#[tauri::command]
pub fn project_usage(
    state: State<AppState>,
    project_id: i64,
) -> AppResult<UsageSummary> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = claude_root()?.join(&proj.claude_dir);

    if !dir.exists() {
        return Ok(UsageSummary {
            tokens: Default::default(),
            cost_usd: 0.0,
            by_model: vec![],
            unknown_models: vec![],
        });
    }

    let files: Vec<PathBuf> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();

    let max_mtime = files.iter().map(|p| mtime_ms(p)).max().unwrap_or(0);

    {
        let cache = state.project_usage_cache.lock();
        if let Some((cached_mtime, summary)) = cache.get(&project_id) {
            if *cached_mtime == max_mtime {
                return Ok(summary.clone());
            }
        }
    }

    let mut acc = UsageAccumulator::default();
    for path in &files {
        if let Ok(file) = fs::File::open(path) {
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                if line.trim().is_empty() { continue; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    acc.add_line(&v);
                }
            }
        }
    }
    let summary = acc.finalize();

    state.project_usage_cache.lock().insert(project_id, (max_mtime, summary.clone()));
    Ok(summary)
}
```

> Note: de-dup is per-`UsageAccumulator`, i.e. per scan. Project scan dedupes across all of the project's files in one accumulator, which is correct because `message.id` is globally unique.

- [ ] **Step 4: Register the commands in `lib.rs`**

Edit `src-tauri/src/lib.rs`, add to the `generate_handler!` list (after `commands::sessions::generate_session_title,`):

```rust
            commands::usage::session_usage,
            commands::usage::project_usage,
```

- [ ] **Step 5: Verify it compiles and existing tests pass**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cargo test 2>&1 | tail -15`
Expected: builds clean; all tests pass (this `cargo test` also materializes the new `src/types/*.ts` — see Task 6).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/usage.rs src-tauri/src/commands/mod.rs src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat(usage): add session_usage and project_usage commands"
```

---

## Task 5: Live usage for the active session (`watcher.rs`)

**Files:**
- Modify: `src-tauri/src/sessions/watcher.rs`

- [ ] **Step 1: Track usage per open session**

Edit `src-tauri/src/sessions/watcher.rs`.

Add to imports at the top:

```rust
use crate::sessions::usage::UsageAccumulator;
```

Change the `OpenSession` struct to hold a usage accumulator:

```rust
struct OpenSession {
    path: PathBuf,
    last_offset: u64,
    usage: UsageAccumulator,
}
```

- [ ] **Step 2: Seed the accumulator on open**

In `SessionWatchers::open`, replace the block that inserts the session:

```rust
        {
            let mut s = self.sessions.lock();
            s.insert(session_id.to_string(), OpenSession { path: path.clone(), last_offset: size });
        }
```

with a version that pre-scans the whole file so the first emitted total is complete:

```rust
        {
            let mut acc = UsageAccumulator::default();
            if let Ok(file) = std::fs::File::open(&path) {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(file).lines().map_while(Result::ok) {
                    if line.trim().is_empty() { continue; }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        acc.add_line(&v);
                    }
                }
            }
            let mut s = self.sessions.lock();
            s.insert(session_id.to_string(), OpenSession { path: path.clone(), last_offset: size, usage: acc });
        }
```

- [ ] **Step 3: Accumulate from the tail and emit `:usage`**

In `handle_change`, the per-session loop currently parses `tail` for blocks/title. Add usage accumulation from the raw tail lines and collect a summary to emit.

Add this declaration near the other `let mut ..._updates` at the top of `handle_change`:

```rust
        let mut usage_updates: Vec<(String, crate::domain::UsageSummary)> = Vec::new();
```

Inside the `for (sid, sess) in sessions.iter_mut()` loop, right after `sess.last_offset = new_size;`, feed the tail's raw lines into the accumulator. The existing `read_tail` returns parsed `HistoryBlock`s only, so add a sibling raw read. Replace:

```rust
            let tail = read_tail(&sess.path, sess.last_offset, new_size);
            sess.last_offset = new_size;
```

with:

```rust
            let prev_offset = sess.last_offset;
            let tail = read_tail(&sess.path, prev_offset, new_size);
            sess.last_offset = new_size;
            for raw in read_tail_lines(&sess.path, prev_offset, new_size) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    sess.usage.add_line(&v);
                }
            }
            usage_updates.push((sid.clone(), sess.usage.finalize()));
```

After the `for (sid, title) in title_updates { ... }` emit loop (before the activity section), add the usage emit loop:

```rust
        for (sid, summary) in usage_updates {
            let _ = app.emit(&format!("session:{sid}:usage"), &summary);
        }
```

- [ ] **Step 4: Add the raw-tail helper**

At the bottom of `watcher.rs`, next to `read_tail`, add:

```rust
fn read_tail_lines(path: &Path, from: u64, to: u64) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return vec![] };
    if f.seek(SeekFrom::Start(from)).is_err() { return vec![]; }
    let mut buf = vec![0u8; (to - from) as usize];
    if f.read_exact(&mut buf).is_err() { return vec![]; }
    String::from_utf8_lossy(&buf)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect()
}
```

- [ ] **Step 5: Verify it compiles and tests pass**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && npm run test:rust 2>&1 | tail -10`
Expected: builds clean; all Rust tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sessions/watcher.rs
git commit -m "feat(usage): emit live usage updates for the active session"
```

---

## Task 6: Generate TS types + IPC wrappers (`tauri.ts`)

**Files:**
- Modify: `src/lib/tauri.ts`
- Generated: `src/types/TokenTotals.ts`, `src/types/ModelUsage.ts`, `src/types/UsageSummary.ts`

- [ ] **Step 1: Materialize the ts-rs types**

Run: `npm run test:rust 2>&1 | tail -5 && ls src/types/UsageSummary.ts src/types/ModelUsage.ts src/types/TokenTotals.ts`
Expected: all three files exist (ts-rs exports during `cargo test`, not build).

- [ ] **Step 2: Re-export the new types from the types barrel**

Check whether `src/types/index.ts` re-exports generated types. Run:

```bash
grep -n "SessionHistory\|GitStatus" src/types/index.ts
```

If those are re-exported there (e.g. `export * from './SessionHistory';`), add matching lines:

```ts
export * from './TokenTotals';
export * from './ModelUsage';
export * from './UsageSummary';
```

If `src/types/index.ts` does not re-export generated types (they are imported by direct path), skip this step — import `UsageSummary` by path in the next step instead.

- [ ] **Step 3: Add the IPC wrappers**

Edit `src/lib/tauri.ts`. Add `UsageSummary` to the type import on line 3 (append to the existing import list):

```ts
import type { Project, SessionMeta, SessionActivity, SessionHistory, HistoryBlock, Action, ActionInput, ActionPatch, DetectedScript, GitStatus, GitUser, ShellInfo, EditorInfo, DiffResult, UsageSummary } from '../types';
```

(If Step 2 determined types are imported by path, instead use `import type { UsageSummary } from '../types/UsageSummary';`.)

Add the three wrappers after `onSessionTitle` (around line 34):

```ts
  sessionUsage: (projectId: number, sessionId: string) =>
    invoke<UsageSummary>('session_usage', { projectId, sessionId }),
  projectUsage: (projectId: number) =>
    invoke<UsageSummary>('project_usage', { projectId }),
  onSessionUsage: (sessionId: string, cb: (usage: UsageSummary) => void): Promise<UnlistenFn> =>
    listen<UsageSummary>(`session:${sessionId}:usage`, e => cb(e.payload)),
```

- [ ] **Step 4: Verify lint passes**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/types/TokenTotals.ts src/types/ModelUsage.ts src/types/UsageSummary.ts src/lib/tauri.ts src/types/index.ts
git commit -m "feat(usage): add usage IPC wrappers and generated types"
```

---

## Task 7: Frontend formatter + UsageSection

**Files:**
- Create: `src/lib/formatUsage.ts`
- Create: `src/components/right/UsageSection.tsx`
- Modify: `src/components/right/RightPanel.tsx`

- [ ] **Step 1: Write the formatter test**

Create `src/lib/formatUsage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatTokens, formatCost } from './formatUsage';

describe('formatTokens', () => {
  it('formats small numbers verbatim', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
  });
  it('formats thousands with k', () => {
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(12000)).toBe('12k');
  });
  it('formats millions with M', () => {
    expect(formatTokens(2_300_000)).toBe('2.3M');
  });
});

describe('formatCost', () => {
  it('uses cents precision under a dollar', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.4231)).toBe('$0.42');
  });
  it('keeps two decimals above a dollar', () => {
    expect(formatCost(12.5)).toBe('$12.50');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- formatUsage`
Expected: FAIL ("Cannot find module './formatUsage'").

- [ ] **Step 3: Implement the formatter**

Create `src/lib/formatUsage.ts`:

```ts
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 || Number.isInteger(k) ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- formatUsage`
Expected: PASS.

- [ ] **Step 5: Create the UsageSection component**

Create `src/components/right/UsageSection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatTokens, formatCost } from '../../lib/formatUsage';
import { IconBtn } from '../shared/IconBtn';
import type { UsageSummary } from '../../types';

function totalTokens(u: UsageSummary): number {
  return u.tokens.input + u.tokens.output + u.tokens.cacheWrite + u.tokens.cacheRead;
}

function UsageLine({ label, usage }: { label: string; usage: UsageSummary | null }) {
  if (!usage) {
    return (
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="text-muted">—</span>
      </div>
    );
  }
  const unknown = usage.unknownModels.length > 0;
  const tooltip = usage.byModel
    .map(m => `${m.model}: ${formatTokens(m.tokens.input + m.tokens.output + m.tokens.cacheWrite + m.tokens.cacheRead)} tok · ${formatCost(m.costUsd)}`)
    .join('\n')
    + (unknown ? `\n(brak ceny: ${usage.unknownModels.join(', ')})` : '');
  return (
    <div className="flex items-center justify-between text-[12px]" title={tooltip}>
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-fg-secondary tabular-nums">{formatTokens(totalTokens(usage))} tok</span>
        <span className="text-fg font-medium tabular-nums">~{formatCost(usage.costUsd)}</span>
        {unknown && <span className="text-warn" title="Część modeli bez ceny">*</span>}
      </span>
    </div>
  );
}

export function UsageSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const sessionId = activeTab?.kind === 'session' ? activeTab.sessionId : null;

  const [sessionUsage, setSessionUsage] = useState<UsageSummary | null>(null);
  const [projectUsage, setProjectUsage] = useState<UsageSummary | null>(null);

  // Active-session usage: initial fetch + live updates via watcher event.
  useEffect(() => {
    setSessionUsage(null);
    if (projectId == null || sessionId == null) return;
    let unlisten: (() => void) | null = null;
    tauri.sessionUsage(projectId, sessionId).then(setSessionUsage).catch(() => {});
    tauri.onSessionUsage(sessionId, setSessionUsage).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [projectId, sessionId]);

  // Project total: refresh on project change, on window focus, and via button.
  const refreshProject = () => {
    if (projectId == null) return;
    tauri.projectUsage(projectId).then(setProjectUsage).catch(() => {});
  };
  useEffect(() => {
    setProjectUsage(null);
    if (projectId == null) return;
    refreshProject();
    const onFocus = () => refreshProject();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <section className="shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Zużycie</span>
        {projectId != null && (
          <IconBtn icon="refresh" label="Odśwież" tone="ghost" size="sm" onClick={refreshProject} />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <UsageLine label="Sesja" usage={sessionUsage} />
        <UsageLine label="Projekt" usage={projectUsage} />
      </div>
    </section>
  );
}
```

> Tab shape (verified against `src/store/tabsSlice.ts`): a session tab is
> `{ kind: 'session'; id; projectId; sessionId; title; mode: 'history' | 'terminal'; linkedSessionId? }`,
> so `activeTab.kind === 'session'` and `activeTab.sessionId` are correct as written.

- [ ] **Step 6: Wire it into RightPanel pinned at the bottom**

Replace `src/components/right/RightPanel.tsx` with:

```tsx
import { ActionsSection } from './ActionsSection';
import { GitSection } from './GitSection';
import { UsageSection } from './UsageSection';
export function RightPanel() {
  return (
    <aside className="h-full bg-bg p-4 text-[13px] flex flex-col gap-4">
      <ActionsSection />
      <div className="border-t border-border" />
      <GitSection />
      <div className="border-t border-border" />
      <UsageSection />
    </aside>
  );
}
```

(`GitSection` is already `flex-1 min-h-0`, so it absorbs free space and `UsageSection` (`shrink-0`) stays pinned at the bottom.)

- [ ] **Step 7: Verify lint passes**

Run: `npm run lint`
Expected: zero errors. If TS complains that `activeTab.sessionId` does not exist on the tab union, fix the derivation per the Step 5 note (read `tabsSlice.ts` for the exact session-tab field).

- [ ] **Step 8: Commit**

```bash
git add src/lib/formatUsage.ts src/lib/formatUsage.test.ts src/components/right/UsageSection.tsx src/components/right/RightPanel.tsx
git commit -m "feat(usage): add Zużycie section to the right panel"
```

---

## Task 8: UsageSection render test

**Files:**
- Create: `src/components/right/UsageSection.test.tsx`

- [ ] **Step 1: Inspect an existing right-panel test for the harness pattern**

Run: `sed -n '1,40p' src/components/right/GitRepoGroup.test.tsx`
Expected: shows how components are rendered/mocked in this repo (render import, store mocking). Mirror that style.

- [ ] **Step 2: Write the test**

Create `src/components/right/UsageSection.test.tsx`. Mock the store to return no active tab and assert the two labels render with the empty placeholder:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageSection } from './UsageSection';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    sessionUsage: vi.fn().mockResolvedValue(null),
    projectUsage: vi.fn().mockResolvedValue(null),
    onSessionUsage: vi.fn().mockResolvedValue(() => {}),
  },
}));

vi.mock('../../store', () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({ tabs: [], activeTabId: null }),
}));

describe('UsageSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders Sesja and Projekt lines with placeholder when no active tab', () => {
    render(<UsageSection />);
    expect(screen.getByText('Sesja')).toBeInTheDocument();
    expect(screen.getByText('Projekt')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBe(2);
  });
});
```

> Note: if `GitRepoGroup.test.tsx` uses a different render/mocking convention (e.g. no `@testing-library/react`, or a shared test util), follow that instead. Adjust the `useStore` mock signature to match how the repo mocks selectors.

- [ ] **Step 3: Run the test**

Run: `npm test -- UsageSection`
Expected: PASS.

- [ ] **Step 4: Full verification**

Run: `npm run lint && npm test && npm run test:rust`
Expected: lint zero errors; all frontend and Rust tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/right/UsageSection.test.tsx
git commit -m "test(usage): render test for the Zużycie section"
```

---

## Done criteria

- Right panel shows a "Zużycie" section at the bottom with two lines (Sesja / Projekt), each showing total tokens and `~$cost`.
- Active session updates live while Claude works (via `session:{sid}:usage`).
- Project total refreshes on project switch, window focus, and the refresh button; cached by max session-file mtime.
- Cost uses per-bucket pricing with the 5m/1h cache-write split; unknown models contribute 0 cost and are flagged with `*`.
- `npm run lint`, `npm test`, `npm run test:rust` all green.
