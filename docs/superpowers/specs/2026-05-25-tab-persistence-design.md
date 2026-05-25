# Tab Persistence Across Restarts

## Goal

Restore previously open tabs when the application restarts, preserving the user's workspace context.

## Scope

- **Persisted**: `session` tabs only (Claude Code conversation sessions).
- **Not persisted**: `action` tabs (running scripts) and `terminal` tabs (shell PTY) — their underlying processes cannot survive a restart.
- **Restore mode**: All session tabs restore in `history` mode (read-only view). The user can manually resume into `terminal` mode.

## Storage

localStorage only, under key `abeoncode.tabs`. No SQLite involvement — tabs are small, ephemeral data that don't need canonical durability.

### Serialized shape

```json
{
  "tabs": [
    {
      "kind": "session",
      "id": "session:abc123",
      "projectId": 1,
      "sessionId": "abc123",
      "title": "Refactor auth"
    }
  ],
  "activeTabId": "session:abc123"
}
```

The `mode` field is intentionally omitted — always `history` on restore.

## Implementation

### Save path

In `src/store/index.ts`, extend the existing `useStore.subscribe` handler. On every state change where `tabs` differ from the previous snapshot:

1. Filter tabs to `kind === 'session'` only.
2. Serialize `{ tabs, activeTabId }` to localStorage under `abeoncode.tabs`.
3. Use the same diff approach as settings persistence to avoid unnecessary writes.

### Load path

In `src/store/index.ts`, synchronously at module load (same timing as settings hydration from localStorage):

1. Read `abeoncode.tabs` from localStorage.
2. Parse and validate: keep only entries with `kind === 'session'`.
3. Set `mode: 'history'` on each tab.
4. If saved `activeTabId` doesn't match any restored tab, fall back to the last tab in the array (or `null` if empty).
5. Apply to initial store state.

### Files changed

1. **`src/store/tabsSlice.ts`** — accept optional initial state for `tabs` and `activeTabId` (passed from the hydration logic in `index.ts`).
2. **`src/store/index.ts`** — add localStorage read at boot, add tabs serialization in the subscribe handler.

## Validation

- Only `session` tabs are persisted (filter on save AND load).
- Graceful degradation: if localStorage is empty, corrupt, or missing — start with no tabs (current default behavior).
- No migration needed — new localStorage key, defaults to empty.

## What we're NOT doing

- No SQLite persistence for tabs.
- No restoration of `action` or `terminal` tabs.
- No automatic PTY spawn on restore (tabs open in history mode).
- No per-project tab memory (all tabs are global, same as current behavior).
