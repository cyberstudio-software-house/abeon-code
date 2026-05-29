# Add Opus 4.8 + lightweight model auto-detection

Date: 2026-05-29
Status: Approved (design)

## Problem

`src/lib/models.ts` keeps a hand-curated `BUILTIN_MODELS` list that drives the
model picker (Settings → Modele). Each new Claude release requires editing this
file by hand. Two concrete needs:

1. Make **Claude Opus 4.8** selectable now.
2. Reduce the manual maintenance burden by **automatically surfacing newly
   available models** that aren't yet in the static list.

Pricing is not affected: `src-tauri/src/sessions/pricing.rs::price_for` already
matches by substring (`opus`/`sonnet`/`haiku`), so a new Opus version resolves
to correct pricing with no change.

## Approach: Hybrid (static floor + best-effort detection)

The static list is always the authoritative floor — the picker is never empty
or wrong. On top of it, a best-effort detection layer surfaces models the user
could select but that aren't in the static list yet.

Detection uses two signals, in order:

- **Binary scan (proactive):** the Claude Code CLI binary embeds its model
  catalog as plain strings (verified: `claude-opus-4-8` is present in 2.1.156).
  Grepping it finds models *before* they have ever been used.
- **Session-history scan (reactive fallback):** AbeonCode already parses model
  IDs out of session JSONL. Any ID seen there but absent from the static list is
  a detected model. Used when the binary scan yields nothing (e.g. an install
  layout where the binary can't be located).

Detected-but-unknown models are surfaced as **one-click suggestions**, never
auto-added silently. The user promotes a suggestion into their custom-models
list via the existing `addCustomModel` flow.

## Components

### 1. Static list (`src/lib/models.ts`)

Add two rows to `BUILTIN_MODELS`, mirroring the existing 4.7 pattern:

```ts
{ id: 'opus-4.8-200k', modelId: 'claude-opus-4-8',     label: 'Claude Opus 4.8', context: '200k', supportsEffort: true },
{ id: 'opus-4.8-1m',   modelId: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8', context: '1M',   supportsEffort: true },
```

These are placed at the top of the list (newest first). `DEFAULT_MODEL_ID`
stays `sonnet-4.6` — the change does not alter the default for new sessions.

### 2. Rust command `detect_models` (`src-tauri/src/commands/models.rs`)

New command module, registered in `lib.rs`, returns a list of detected model
IDs. Never errors outward — failure or empty result returns `[]`.

Returned type (with `#[derive(TS)]`, exported to `src/types/`):

```rust
pub struct DetectedModel {
    pub model_id: String,   // CLI alias form, e.g. "claude-opus-4-8"
    pub family: String,     // "opus" | "sonnet" | "haiku"
    pub source: String,     // "binary" | "session"
}
```

Resolution + scan steps:

1. **Locate the binary.** Resolve `claude` the same way the PTYs do — via the
   user's shell PATH (`commands::settings::ensure_shell_env` already caches that
   env). Take the resolved path, follow symlinks (`std::fs::canonicalize`).
2. **Scan.** Read the file bytes and extract matches of
   `claude-(opus|sonnet|haiku)-\d+-\d+` (regex over the byte stream as lossy
   UTF-8). This pattern works on both the native ELF and an npm JS bundle.
3. **Normalize.** Keep only the clean alias form. Drop dated suffixes
   (`-20251101`), `-v1`, and bare base aliases (`claude-opus-4`,
   `claude-opus-4-0`). For each opus alias also synthesize the `[1m]` variant
   (matches the runtime suffixing the CLI applies). Dedupe.
4. **Fallback.** If the binary can't be located or yields zero matches, scan
   model IDs already extracted from session JSONL (reuse the existing usage
   parsing path) and return those with `source: "session"`.

Detection is intentionally cheap and on-demand — it does not run at app startup.

### 3. IPC wrapper (`src/lib/tauri.ts`)

Add `detectModels(): Promise<DetectedModel[]>` following the existing wrapper
convention (no direct `invoke` from components).

### 4. Frontend merge + UI (`src/components/dialogs/SettingsDialog.tsx`)

- A pure helper computes "unknown detected models" = detected IDs minus
  (`BUILTIN_MODELS` modelIds ∪ `customModels` modelIds).
- `ModelsTab` calls `detectModels()` once when the tab mounts, with a manual
  "Odśwież" button to re-run.
- Unknown models render in a new **"Wykryte modele"** group. Each row shows the
  model ID and a "Dodaj" button that calls `addCustomModel` (generating a label
  from the family/version), after which it moves into "Modele własne".
- Empty detection result → the group is hidden entirely (no empty state noise).

## Data flow

```
ModelsTab mount
  → tauri.detectModels()
      → Rust: locate binary → grep → normalize  (or session-JSONL fallback)
      → DetectedModel[]
  → diff against BUILTIN_MODELS + customModels
  → render unknowns under "Wykryte modele"
  → user clicks "Dodaj" → addCustomModel() → store + persist
```

## Error handling

- Binary not found, unreadable, or regex finds nothing → fall back to session
  scan. Session scan empty → return `[]`. The UI simply shows no suggestions.
- `detect_models` must not panic or surface an error toast; detection is an
  enhancement, not a critical path.

## Testing

- **Rust (`models.rs`):** unit-test the normalize function against a fixture
  byte blob containing the real mix (dated, `-v1`, base aliases, clean aliases)
  → asserts only clean aliases survive and opus gets a `[1m]` variant. Test the
  family classifier. Locating the binary is environment-dependent and is not
  unit-tested.
- **Rust (`pricing.rs`):** add a case asserting `price_for("claude-opus-4-8")`
  resolves to opus pricing (guards the substring contract for the new version).
- **Frontend (`models.ts`):** test `getCliModelString` / `getModelDisplayLabel`
  for the new `opus-4.8-*` ids.
- **Frontend (merge helper):** test that a detected ID already in
  `BUILTIN_MODELS` or `customModels` is filtered out, and an unknown one is kept.
- **Lint:** `npm run lint` clean; `cargo test` materializes the new TS type.

## Out of scope (YAGNI)

- Auto-adding detected models without user action.
- Querying the Anthropic `/v1/models` REST endpoint (different ID namespace,
  requires an API key, mismatches CLI subscription mode).
- A user-configurable explicit path to the `claude` binary.
- Caching detection results across sessions — it's cheap and on-demand.
