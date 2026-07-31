# Session duration + project summary modal — design

Date: 2026-07-31
Status: approved (pending spec review)

## Goal

Two changes to the **"Zużycie"** section (bottom of the right panel):

1. **Add session duration.** Show how long the active session lasted, in two flavours:
   - **Czas sesji** — wall-clock span from first to last event in the session file.
   - **Czas aktywny** — sum of inter-event gaps, ignoring idle gaps longer than a threshold
     (the "time actually spent working").
2. **Remove the project total** from the section and move it into a dedicated
   **project summary modal**, opened from the project context menu ("Zarządzaj projektem").

After the change the "Zużycie" section is entirely about the active session; the project-wide
view lives in the modal.

## Why this is feasible

Every line in a Claude Code session `*.jsonl` carries a `timestamp` (RFC3339). The existing
`UsageAccumulator` already reads every line during scan/tail — it just ignores non-usage lines.
Capturing the timestamp on every line adds duration "for free" on the same pass, and because the
watcher seeds the accumulator with a full file scan on `open()` and appends tail lines afterwards,
`finalize()` yields the correct full-session duration both on the initial call and live.

Session count for the modal already exists as the `count_sessions` command (`tauri.countSessions`),
so no new backend is needed for that number.

## Chosen decisions

| Decision | Choice |
|---|---|
| Session-duration semantics | Both: wall-clock span **and** active time (two lines) |
| Idle threshold for active time | 5 minutes (gap > 5 min does not count as work) |
| Duration transport | Folded into `UsageSummary` (`Option<i64>` fields) → live via existing usage event |
| Modal contents | Session count + total tokens + cost + per-model table |
| Modal trigger | New "Podsumowanie" item in `ProjectManageMenu` |
| Usage-section refresh button | Removed (session is event-driven; project moved to modal) |

## Backend (Rust)

### `sessions/usage.rs` — `UsageAccumulator`

- New field `timestamps: Vec<i64>`.
- `add_line` extracts the line `timestamp` (RFC3339 → unix ms) for **every** line that has one,
  independent of whether the line carries `message.usage`. (Reuse the RFC3339 parse used by
  `sessions/parser.rs::ts_ms`.)
- `finalize()` computes, after sorting `timestamps`:
  - `duration_ms = last − first`
  - `active_ms = Σ (t[i] − t[i-1])` for gaps `≤ ACTIVE_GAP_MS` (5 min)
  - both `None` when there are no timestamps.
- Sorting (not incremental accumulation) is chosen for robustness against slightly out-of-order
  lines (sidechains/subagents); cost is negligible at realistic session sizes.

### `domain/usage.rs` — `UsageSummary`

Add two nullable fields (meaningful only for a single-session summary; ignored by the project view):

```rust
pub struct UsageSummary {
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    pub unknown_models: Vec<String>,
    pub duration_ms: Option<i64>,   // wall-clock span, session only
    pub active_ms: Option<i64>,     // active time (gaps ≤ 5 min), session only
}
```

Regenerate `src/types/UsageSummary.ts` with `cargo test` (ts-rs). `Option<i64>` → `number | null`.

No change to `commands/usage.rs` signatures or the watcher emit path — both already return/emit
`UsageSummary` via `finalize()`.

## Frontend

### `lib/formatUsage.ts`
- New `formatDuration(ms: number): string` — compact human form: `2h 14m`, `3m 20s`, `45s`, `0s`.

### `components/right/UsageSection.tsx`
- Remove the "Projekt" line, `projectUsage` state, its effect, `refreshProject`, and the refresh
  `IconBtn`.
- Keep the "Sesja" line (tokens + cost) with its live `onSessionUsage` subscription.
- Add two lines below it: **"Czas sesji"** (`durationMs`) and **"Czas aktywny"** (`activeMs`),
  each showing `formatDuration` or `—` when null / no active session.

### `components/dialogs/ProjectSummaryDialog.tsx` (new)
- Props `{ project, onClose }`; styling mirrors `EditProjectDialog`.
- On open: `tauri.projectUsage(project.id)` + `tauri.countSessions(project.id)`.
- Renders: session count, total tokens, cost, and a **per-model table** (model · tokens · cost)
  instead of a cramped tooltip, plus a note listing models with no price (`unknownModels`).
- Loading + empty states; UI text in Polish.

### `components/sidebar/ProjectManageMenu.tsx`
- New `onSummary` prop and a "Podsumowanie" menu item (with an appropriate icon), above Edytuj/Usuń.

### `components/sidebar/ProjectItem.tsx`
- `summaryOpen` state; pass `onSummary` to `ProjectManageMenu`; render `ProjectSummaryDialog` when open.

## Testing

- **Rust** `usage.rs`: `finalize()` returns correct `duration_ms` (span) and `active_ms` with a gap
  exceeding the 5-min threshold excluded; `None` when no timestamps.
- **Front** `formatUsage`: `formatDuration` cases (seconds / minutes / hours).
- **Front** `UsageSection.test.tsx`: no "Projekt" line; "Czas sesji" / "Czas aktywny" present with
  `—` when no active session.
- **Front** `ProjectSummaryDialog` test: renders session count + totals + per-model rows.
- **Front** `ProjectManageMenu.test.tsx`: new "Podsumowanie" item fires `onSummary`.
- `npm run lint` zero errors; run `cargo test` once so ts-rs materializes `UsageSummary.ts`.

## Out of scope (YAGNI)

- Configurable idle threshold in Settings (fixed 5 min).
- Duration for the whole project (span across sessions is not meaningful).
- Codex duration (usage/cost is Claude-only in v1; duration naturally comes out empty).
- Persisting duration snapshots (computed on demand).
