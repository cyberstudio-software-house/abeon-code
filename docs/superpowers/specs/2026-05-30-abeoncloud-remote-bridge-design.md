# AbeonCloud — Remote Bridge (Design)

**Date:** 2026-05-30
**Status:** Approved (design) — pending spec review before planning
**Scope of this document:** Sub-project #2 (Desktop Bridge) + the shared contract, plus a roadmap for the remaining sub-projects.

## Goal

Allow controlling AbeonCode's running AI-CLI sessions from a mobile app over the
network: view active sessions and their live history, issue high-level commands
to running processes (prompt / approve / deny / stop), and remotely resume a
session that is not currently running.

## Decisions (locked)

1. **Trust model:** single-user at start, architecture must not block evolution
   to multi-tenant.
2. **Control granularity:** high-level domain commands, not raw PTY byte
   streaming. The desktop translates commands into `pty_write`.
3. **Transport:** Centrifugo (already deployed) as the relay. Desktop and mobile
   are both Centrifugo clients.
4. **Continue a session:** includes remote process start (`claude --resume <id>`
   spawned on the desktop on demand) — the most sensitive operation.
5. **Mobile stack:** React Native / Expo.
6. **Bridge location:** Rust-side (`src-tauri`), next to `PtyManager` and
   `SessionWatchers`, independent of webview focus/lifetime.

## Architecture overview

```
┌─────────────────┐         events (down)          ┌──────────────────┐
│  AbeonCode      │ ──────────────────────────────▶│                  │
│  Desktop        │   publish sess:<id> activity/   │                  │
│  (Tauri)        │   history/title/usage           │    Centrifugo    │
│                 │                                  │    (relay)       │
│  ┌───────────┐  │   subscribe cmd:<device>        │                  │
│  │  Bridge   │  │ ◀──────────────────────────────│                  │
│  └─────┬─────┘  │   commands (up)                 └────▲────────┬────┘
│        │ maps   │                                  events│        │ pub cmd
│  ┌─────▼─────┐  │                                  (down)│        ▼ (via API)
│  │PtyManager │  │       ┌──────────────┐                 │   ┌─────────┐
│  │ + Session │  │       │ Auth/Pairing │◀── REST ────────┼───│ Mobile  │
│  │ Watchers  │  │       │ + JWT minter │   pairing/token/ │   │ (RN/    │
│  └───────────┘  │       └──────┬───────┘   cmd authz      └───│ Expo)   │
└─────────────────┘              │ Centrifugo server API        └─────────┘
                                 ▼
                              Centrifugo
```

### Flow asymmetry (core of the design)

- **Downstream (events):** desktop publishes directly to Centrifugo. High
  volume, low risk. This forwards the events `SessionWatchers` already produces
  (`session:{id}:append/activity/title/usage`) onto channel `sess:<id>`. Mobile
  subscribes with a read-only token.
- **Upstream (commands):** mobile does **not** publish to the desktop directly.
  It calls the auth service over REST; the auth service authorizes the command
  and only then publishes it (Centrifugo server API) to channel `cmd:<device>`,
  which the desktop subscribes to. Low volume, high risk (especially
  `resumeSession`). This is the single authorization checkpoint and the natural
  home for later multi-tenant RBAC.

Rationale: when moving to multi-tenant, the change is concentrated in the auth
service (who may publish which command to whose channel). The desktop and the
channel topology stay the same; namespaces `sess:` / `cmd:` simply gain an owner
prefix.

## Channel topology

| Channel            | Direction      | Publisher | Subscriber | Purpose                          |
|--------------------|----------------|-----------|------------|----------------------------------|
| `sess:<sessionId>` | down           | desktop   | mobile     | append/activity/title/usage      |
| `dev:<deviceId>`   | down           | desktop   | mobile     | presence, which sessions online  |
| `cmd:<deviceId>`   | up             | auth svc  | desktop    | authorized RemoteCommands        |

Multi-tenant evolution: prefix with owner, e.g. `u:<ownerId>:sess:<id>`. Tokens
are scoped per owner; topology is unchanged.

## The command/event contract

Defined in Rust with `#[derive(TS)]` (like `PtyKind`), exported to `src/types/`,
shared with the Expo app via TS types. Tag convention follows `PtyKindClient`:
camelCase variant tag, snake_case struct-variant fields.

```ts
type RemoteCommand =
  | { type: 'sendPrompt';        sessionId: string; text: string }
  | { type: 'approvePermission'; sessionId: string }
  | { type: 'denyPermission';    sessionId: string }
  | { type: 'stopSession';       sessionId: string }
  | { type: 'resumeSession';     sessionId: string; projectId: number } // remote spawn

type RemoteEnvelope = { commandId: string; command: RemoteCommand }

type RemoteEvent =
  | { type: 'cmdResult'; commandId: string; ok: boolean; error?: string }
  | { type: 'sessionAppend'; sessionId: string; /* mirrors session:append */ }
  | { type: 'sessionActivity'; sessionId: string; activity: SessionActivity }
  | { type: 'sessionTitle'; sessionId: string; title: string }
  | { type: 'sessionUsage'; sessionId: string; /* mirrors session:usage */ }
```

Every command carries a `commandId` for idempotency and a returning `cmdResult`
acknowledgement.

## Desktop bridge — module layout (`src-tauri/src/remote/`, new)

| File          | Responsibility                                                                 |
|---------------|--------------------------------------------------------------------------------|
| `protocol.rs` | `RemoteCommand` / `RemoteEvent` / `RemoteEnvelope` with `#[derive(TS)]`.        |
| `client.rs`   | Centrifugo client over WebSocket (JSON protocol). connect/subscribe/publish + reconnect. **Research item** (see Risks). |
| `bridge.rs`   | Orchestration: subscribe `cmd:<device>`, dispatch commands, forward events to `sess:<id>`. |
| `registry.rs` | `Mutex<HashMap<sessionId, ptyId>>` — the mapping not currently held in Rust.    |

### Touch points in existing code

1. **`state.rs` (`AppState`)** — add `remote: Arc<RemoteBridge>` and the
   `sessionId → ptyId` registry.
2. **Internal event bus** — `SessionWatchers` currently calls `app.emit(...)`.
   Add a `tokio::sync::broadcast` bus alongside it: the watcher publishes to the
   bus, the existing `emit` to the webview stays **unchanged** (no frontend
   regression), and the bridge subscribes to the bus and forwards to Centrifugo.
3. **PTY registration** — in `spawn_pty`, for `PtyKind::Claude { session_id }`,
   record `sessionId → ptyId` in the registry; clear it on `pty:exit`.
4. **Command dispatch** (`bridge.rs`):
   - `sendPrompt` → `registry.lookup(sessionId)` → `PtyManager::write(ptyId, text + "\r")`
   - `approvePermission` / `denyPermission` → `write` the appropriate key sequence
   - `stopSession` → `PtyManager::kill(ptyId)`
   - `resumeSession` → `spawn_pty(Claude{ resume })`; registry updates via (3)

## Security model

MVP is single-user but built on multi-tenant-ready primitives.

- The desktop registers with the auth service and receives a short-lived
  **Centrifugo JWT** scoped to: publish only to its own `sess:`/`dev:` channels,
  subscribe only to its own `cmd:` channel.
- Commands are authorized **server-side** by the auth service before they are
  published to a channel.
- `resumeSession` (remote spawn) sits behind an extra gate: an in-app setting
  `allowRemoteSpawn` (default off) plus a returning `cmdResult` ACK. This is the
  narrowest possible privilege for the most sensitive operation.
- Device pairing: desktop displays a QR/one-time code; the mobile app exchanges
  it at the auth service for a long-lived device credential. (Belongs to
  sub-project #3 but the desktop must surface the pairing UI.)

## Error handling

- Centrifugo disconnect → bridge reconnects with backoff; while disconnected,
  downstream events are dropped (mobile recovers via Centrifugo channel history
  + an on-demand snapshot). Commands are not lost because they are only
  published by the auth service when the desktop is present (presence-gated).
- Command targets an unknown/dead `sessionId` → `cmdResult { ok: false, error }`.
- `resumeSession` with `allowRemoteSpawn=false` → `cmdResult { ok: false }`.

## Testing

- `protocol.rs` serialization round-trip (tag/field casing matches the contract).
- Command dispatch against fakes for `PtyManager` / registry.
- watcher → bus → bridge forwarding test.
- Reuse the `TEST_ENV_LOCK` pattern if any test mutates process env.

## Risks

- **Centrifugo Rust client maturity** is the main unknown. `client.rs` must be
  scoped during phase research: existing crate vs. a thin JSON-protocol
  implementation over `tokio-tungstenite`. Everything else attaches to existing,
  well-defined ports (`pty_write`, `spawn_pty`, watcher events) — low risk.

## Sub-project roadmap

1. **Contract** — `RemoteCommand` / `RemoteEvent` + channel topology. (Part of
   the bridge spec.)
2. **Desktop bridge** *(this repo)* — the heart; this document.
3. **Auth/pairing microservice** — device pairing, JWT minting, command
   authorization. Separate service/repo.
4. **Mobile app (RN/Expo)** — Centrifugo JS client + REST. Separate repo.

### MVP phasing

- **A.** Bridge forwards events → mobile sees live sessions (read-only).
- **B.** Upstream commands (prompt / approve) → control.
- **C.** `resumeSession` → remote start.
- **D.** Proper pairing/auth → hardening for multi-tenant.

## Out of scope (YAGNI for now)

- Raw terminal streaming to mobile.
- Multi-tenant accounts/RBAC/billing (architecture leaves room; not built now).
- Mobile app implementation details (separate spec).
