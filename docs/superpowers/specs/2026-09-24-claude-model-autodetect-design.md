# Claude models: autodetection only + per-model effort — design

Date: 2026-09-24 · App: `DesktopApp/` · Scope: Settings → Modele → Claude Code (plus the
Claude title-generation selector and the sidebar footer label).

## Problem

- The Claude model list is driven by the hard-coded `BUILTIN_MODELS` array
  (`src/lib/models.ts`). Every new Claude model requires an app release.
- Detected models appear in a separate "Wykryte modele" section, and only when they are
  newer than the built-ins. Together with "Modele własne" the tab shows three
  overlapping lists.
- The per-model effort selector is dead UI: `modelEfforts` is persisted but never read.
  `build_claude_command` (`src-tauri/src/commands/pty.rs`) only passes `--model`.
- The app knows only `low | medium | high`. CLI 2.1.281 accepts
  `low, medium, high, xhigh, max`.

## Goals

1. The Claude model list comes only from autodetection, with no hard-coded model catalogue.
2. Every option, including "Auto", can have its own effort, and that effort really reaches
   the CLI as `--effort`.
3. New models and new effort levels show up without an app update.

## Non-goals

- Effort for Codex / OpenCode (separate iteration; different CLI contracts).
- Effort for title generation and for sessions spawned remotely from the mobile app.
- Any change to how `--model` is quoted in the PTY shell command.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| List shape | Newest version per family is visible; older versions sit under "Pokaż starsze wersje (N)". |
| Custom models | Kept as an escape hatch, collapsed under "Zaawansowane". Custom models get effort too. |
| Effort levels | Detected by parsing `claude --help`, with a static fallback list. |
| Scope | Claude only. |

## 1. Data model and migration

- **Model identity = raw CLI model string.** `defaultModelId` holds exactly what is passed
  to `--model` (e.g. `claude-opus-5-5[1m]`). `''` means Auto, so no `--model` is passed.
- **`titleGenModelId`** follows the same rule. The default for new installs is the CLI alias
  `haiku`, which the CLI always resolves to the newest Haiku, so no version number is
  hard-coded.
- **`modelEfforts: Record<string, string>`** is keyed by the raw model string (`''` for
  Auto). A missing entry means "Domyślny", so no `--effort` is passed.
  `EffortLevel` stops being a closed union and becomes `string`.
- **`customModels: { modelId: string; label: string }[]`**: the synthetic `id` field is
  dropped. Removing a custom model resets `defaultModelId` / `titleGenModelId` to their
  defaults if they point at it, and deletes its `modelEfforts` entry.
- **Migration** runs in `applyPersistedToState` (`src/store/index.ts`) through a pure
  function `migrateClaudeModelSettings(persisted)` in `src/lib/models.ts`:
  - `LEGACY_MODEL_IDS` is a static map from old built-in ids (`fable-5`, `opus-4.8-200k`,
    `opus-4.8-1m`, `opus-4.7-*`, `opus-4.6-*`, `sonnet-4.6`, `haiku-4.5`) to their raw
    model strings. It exists only for migration.
  - `custom-*` ids map to the matching custom model's `modelId`. An unknown `custom-*`
    id maps to `''` for the default model, or `haiku` for title generation.
  - Values that already start with `claude-`, and the aliases, pass through unchanged.
  - `modelEfforts` keys are remapped with the same function. Old custom models lose `id`.
  - The migration is idempotent, so running it on already-migrated data is a no-op.
- **Removed:** `BUILTIN_MODELS`, `BuiltinModel`, `detectedClaudeModels`,
  `DetectedSuggestion`, the `claude-sonnet-4-6` fallback in `getCliModelString`.
- **`getCliModelString(id)`** returns `id || null`. **`getModelDisplayLabel(id,
  customModels)`** gives `Auto` for `''`, the custom model's label if one matches,
  `claudeAliasLabel(id)` for `claude-*` ids, and otherwise the raw id (e.g. the `haiku`
  alias).

## 2. Detection (Rust, `src-tauri/src/commands/models.rs`)

- New command `detect_claude_options(force: Option<bool>) -> ClaudeOptions` replaces
  `detect_models`. The command registration, the `tauri.ts` wrapper and the `AppState`
  cache are updated to match.
- `ClaudeOptions { models: Vec<DetectedModel>, effort_levels: Vec<String> }` is exported
  to TS through ts-rs. The new type must also be re-exported manually in
  `src/types/index.ts`.
- `DetectedModel` gains `latest: bool`: true when the model has the highest
  `(major, minor)` in its family. A `[1m]` variant inherits the flag of its base model.
  Models come back sorted by family, then by version, newest first.
- `NON_MODEL_FAMILIES` is extended to `code, cli, desktop, eval, instant`. Other old
  versions are kept and land in the "older" group.
- **Effort levels:** `claude --help` is run with the resolved shell `PATH`, as in
  `locate_binary`. A regex finds the parenthesised list on the line after the
  `--effort` flag and keeps entries that match `^[a-z]+$`. If the command fails, times
  out (5 s) or the pattern is missing, the fallback is
  `["low", "medium", "high", "xhigh", "max"]`.
- Detection never errors. An empty model list is a valid result.

## 3. Passing effort to the CLI

- `PtyKind::Agent` gains `effort: Option<String>` (ts-rs type regenerated).
- `build_claude_command(session_id, model, effort, skip_permissions, fresh)` appends
  `--effort <level>` wherever it appends `--model`: fresh sessions and new sessions, not
  `--resume`. The effort is appended only if it matches `^[a-z]+$`, because the command
  is a shell string and the value comes from persisted settings.
- `TerminalView` sends `effort = modelEfforts[defaultModelId]` for non-resume Claude
  agent tabs.
- Remote dispatch (`remote/dispatch.rs`) passes `effort: None`.

## 4. UI — Settings → Modele → Claude Code

```
Claude Code                                   [Odśwież]
Model używany przy tworzeniu nowych sesji…

(•) Auto (domyślny model Claude)          Effort [Domyślny ▾]
( ) Opus 5.5         claude-opus-5-5      Effort [Domyślny ▾]
( ) Opus 5.5 (1M)    claude-opus-5-5[1m]  Effort [high     ▾]
( ) Sonnet 5         claude-sonnet-5      Effort [Domyślny ▾]
…
▸ Pokaż starsze wersje (14)

▸ Zaawansowane
    Modele własne: rows with radio + effort + delete, „Dodaj własny model” form
```

- Row order: Auto, then `latest` models, then older models when expanded, then custom
  models when "Zaawansowane" is expanded.
- Every row uses one `ModelRow` component (radio, label, mono raw id, effort select). The
  effort select lists "Domyślny" followed by the detected `effortLevels`. Choosing
  "Domyślny" deletes the `modelEfforts` entry.
- The selected model is always visible. If it is in the older group, that group starts
  expanded. If it is custom, "Zaawansowane" starts expanded. If it is a `claude-*` or alias
  id that is neither detected nor custom, it gets its own row with a "niewykryty" badge.
- A stored effort that is not in the detected levels still shows as a selectable option,
  so it is never silently dropped.
- "Odśwież" calls `detect_claude_options(true)`.
- **Title generation selector** (`TitleGenSection`) lists Auto, `haiku` as
  "Haiku (najnowszy)", then `latest` detected models, custom models, and the current
  value if it matches none of these. It has no effort.
- **Sidebar footer** uses the new `getModelDisplayLabel`.

## Error handling

- If detection fails, the list shows Auto plus custom models plus the current selection.
  A short note says "Nie wykryto modeli — sprawdź instalację Claude Code".
- If `--help` parsing fails, the fallback effort list is used silently.

## Testing

- **Rust (`models.rs`):** the `latest` flag per family, including the `[1m]` variant
  inheriting it; sort order; the new denylist families are rejected; the effort parser
  on a real `--help` excerpt, on missing output and on garbage.
- **Rust (`pty.rs`):** `--effort` is appended on new and fresh sessions, not on resume,
  and is rejected when it does not match `^[a-z]+$`.
- **Vitest (`models.test.ts`):** `migrateClaudeModelSettings` for legacy built-in ids,
  custom ids, unknown custom ids, remapped `modelEfforts` keys, and idempotency;
  `getModelDisplayLabel` and `getCliModelString`.
- **Vitest (Settings):** the Claude section renders detected latest rows and hides older
  ones until toggled, the effort select writes and clears `modelEfforts`, and the
  "niewykryty" row appears.
