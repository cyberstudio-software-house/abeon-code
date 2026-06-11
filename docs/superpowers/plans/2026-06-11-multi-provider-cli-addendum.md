# Multi-Provider CLI — Addendum: Settings Restructure + Per-Provider Models

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Continues `2026-06-11-multi-provider-cli.md` after on-device QA feedback.

**Goal:** (R1) CLI providers get their own Settings tab; (R2) the Models tab offers model selection for every ACTIVE CLI (Codex gains model choice); (R3) the title-generation model moves to the CLI tab and is selectable per CLI (Codex sessions generate titles via `codex exec`).

**Architecture:** Codex models are plain strings (no builtin catalog): default `''` = "Auto" (no `-m` flag, Codex config decides). Detection scans recent rollouts' `turn_context.payload.model` values (`detect_codex_models`). Title generation dispatches by the session's provider: Claude keeps `claude -p --no-session-persistence`; Codex uses `codex exec --ephemeral --skip-git-repo-check -o <tmpfile>` run from a temp dir — **verified on codex-cli 0.139: `--ephemeral` persists no rollout and `-o` captures the last message cleanly**.

**New persisted settings:** `codexModelId: string` ('' = Auto), `codexTitleGenModelId: string` ('' = Auto), `codexCustomModels: string[]` (plain model-id strings).

**Settings layout:** tabs `Ogólne | CLI | Modele | Skróty`. CLI tab = ProvidersSection (moved from Ogólne) + "Model do generowania tytułów" select per ENABLED provider (Claude: existing builtin+custom select bound to `titleGenModelId`, moved out of Modele; Codex: Auto + detected + custom, bound to `codexTitleGenModelId`). Modele tab = one section per ENABLED provider (Claude: existing content minus the title-gen block; Codex: Auto radio + detected radios + custom list with add/remove bound to `codexModelId`/`codexCustomModels`).

**Spawn:** `TerminalView` passes `model` for fresh Codex spawns too (`codexModelId` when non-empty); resume still ignores model (backend contract unchanged). `validate_model` already permits `gpt-…` ids (allowlist includes dots).

**Title flow:** `HistoryHeader` picks per provider: claude → `getCliModelString(titleGenModelId, customModels)`; codex → `codexTitleGenModelId || undefined`.

---

### Task A14 (backend): `detect_codex_models` + codex title generation
- `sessions/codex/reader.rs`: `pub fn detect_models(root: &Path) -> Vec<String>` — newest ≤20 rollouts via `scan_sessions`, read ≤80 lines each via `open_lines`, collect distinct `turn_context.payload.model` strings (insertion order, newest file first). Tests with temp tree.
- `commands/providers.rs`: `#[tauri::command] detect_codex_models(...) -> Vec<String>` (register in lib.rs; wrapper `tauri.detectCodexModels()`).
- `commands/sessions.rs`: extract `clean_title(raw) -> String` (first non-empty line, trim quotes/backticks, 80 chars — shared by both arms; unit-tested). `generate_session_title` Codex arm: `codex exec --ephemeral --skip-git-repo-check --color never [-m <model>] -o <tmpfile> <prompt>`, `current_dir(temp_dir)`, 90s timeout, read+remove tmpfile, `clean_title`.

### Task A15 (frontend state): codex model settings + spawn wiring
- `settingsSlice`: `codexModelId`, `codexTitleGenModelId` (strings, default ''), `codexCustomModels: string[]` + setters (`setCodexModel`, `setCodexTitleGenModel`, `addCodexCustomModel` (dedup, trim), `removeCodexCustomModel` (resets selections pointing at it to '')). Tests.
- `store/index.ts`: full 6-spot persistence for all three keys (strings plain; array JSON).
- `TerminalView`: fresh codex spawns send `model: codexModelId` when non-empty.
- `HistoryHeader`: per-provider title model (claude mapping unchanged; codex passes `codexTitleGenModelId || undefined`).

### Task A16 (frontend UI): Settings restructure
- `SettingsTab = 'general' | 'cli' | 'models' | 'shortcuts'`; buttons Ogólne | CLI | Modele | Skróty.
- New `CliTab`: ProvidersSection (moved) + per-enabled-provider title-gen selects (labels: "Model do generowania tytułów").
- `ModelsTab`: per-enabled-provider sections; Claude section = existing content minus title-gen block; Codex section = Auto/detected/custom radios + add/remove custom (uses `tauri.detectCodexModels()`).
- `GeneralTab`: ProvidersSection removed.

### Task A17: verification + docs
- Full suites; update `DesktopApp/CLAUDE.md` (Providers section: v1 limits drop "model selection Claude-only" and "title generation always uses claude -p"); final review of addendum range.

**Out of scope (unchanged):** remote bridge Claude-only; usage Claude-only; effort levels remain Claude-only (Codex effort is a config-level concept, not per-spawn).
