# AbeonCloud — Onboarding & Handoff

Single entry point for picking up this project in a fresh session. Read this, then
dive into the linked docs as needed. (Per-app deep docs: `DesktopApp/CLAUDE.md`.)

## What this is

**AbeonCloud** lets a mobile app remotely control AI-CLI coding sessions (Claude
Code) running on a desktop, relayed through **Centrifugo**. From the phone you can:
view active sessions + live history, send high-level commands (prompt / approve /
deny / stop), and resume a session (remote process start, gated).

Repo is a **monorepo**:

| Dir | What | Status |
|-----|------|--------|
| `DesktopApp/` | Tauri 2 + React 19 desktop app (the bridge lives here) | **done, live-validated** |
| `CloudService/` | Auth/pairing + command-authorization microservice | **not started (#3)** |
| `MobileApp/` | React Native / Expo client | **not started (#4)** |
| `docs/superpowers/` | Specs, plans, research (project-wide) | — |

Centrifugo itself is external infra (already deployed), not code here.

## Current status (all merged to `main`)

The **desktop side of the remote bridge is complete and validated end-to-end**
against the production Centrifugo. 183 Rust tests + 1 gated live test green; `npm
run lint` clean.

Delivered: 2a (command contract + `sessionId→ptyId` registry + pure dispatch),
2b-α (Centrifugo JSON wire codec, `CentrifugoClient` trait + fake, event bus tapped
from `SessionWatchers`, bridge handler), 2b-β (real `tokio-tungstenite` client,
HS256 token minting, async run-loop, production `PtyActuator`, `allowRemoteSpawn`
setting, registry unbind on `pty:exit`, startup wiring), plus input-validation
security hardening.

## Architecture (the parts that matter)

```
DesktopApp (Tauri)                 Centrifugo (relay)              Mobile / CloudService
  bridge ──publish events──▶  abeon-cloud-sess:<id> ──────▶  mobile subscribes (read-only)
         ──publish results─▶  abeon-cloud-dev:<device> ───▶  mobile subscribes
  bridge ◀──subscribe cmds──  abeon-cloud-cmd:<device> ◀──  CloudService publishes (server API, authorized)
```

**Flow asymmetry (core design):** events flow desktop→Centrifugo→mobile *directly*
(high volume, low risk). Commands flow mobile→**CloudService (authz)**→Centrifugo→
desktop (low volume, the single authorization checkpoint — and where multi-tenant
RBAC will live). Today CloudService doesn't exist yet, so for testing the desktop
mints its own connection token from the HMAC secret.

**Command/event contract** (Rust `#[derive(TS)]`, exported to `DesktopApp/src/types/`):
- `RemoteCommand` = `sendPrompt | approvePermission | denyPermission | stopSession | resumeSession`
- `RemoteEvent::cmdResult` (ack) + session mirror events (append/activity/title/usage)
- Defined in `DesktopApp/src-tauri/src/remote/protocol.rs`. The desktop translates
  these into PTY actions; it never exposes raw terminal bytes to the network.

**Design principle:** single-user now, **multi-tenant-ready**. Channel namespaces
(`abeon-cloud-cmd/sess/dev`) gain an owner prefix later; the auth checkpoint is
already isolated in (future) CloudService.

## Where the desktop code lives (`DesktopApp/src-tauri/src/`)

| File | Responsibility |
|------|----------------|
| `remote/protocol.rs` | `RemoteCommand` / `RemoteEnvelope` / `RemoteEvent` contract (ts-rs). |
| `remote/registry.rs` | `SessionPtyRegistry` — `sessionId → ptyId`. |
| `remote/dispatch.rs` | Pure `command_to_action` + `PtyAction` + `session_to_bind`. **The approve/deny key sequences live here** (`APPROVE_KEYS="\r"`, `DENY_KEYS="\x1b"`) — confirm against the real Claude TUI. |
| `remote/wire.rs` | Centrifugo JSON wire codec (encode/parse, ping). |
| `remote/client.rs` | `CentrifugoClient` trait + `FakeCentrifugoClient`. |
| `remote/ws_client.rs` | Real `tokio-tungstenite` client (rustls+ring) + mock-server test + gated live test. |
| `remote/bus.rs` | `RemoteEventBus` (tokio broadcast); tapped by `sessions/watcher.rs`. |
| `remote/bridge.rs` | `RemoteBridge::{handle_envelope, run}`, `PtyActuator` trait + `AppPtyActuator`, channel helpers `{cmd,result,session}_channel`. |
| `remote/token.rs` | HS256 connection/subscription token minting. |
| `remote/startup.rs` | Startup wiring, gated by `remoteBridgeEnabled` setting + `CENTRIFUGO_TOKEN_SECRET` env. |
| `validation.rs` | `validate_session_id` / `validate_model` — the network-input trust boundary. |

## Centrifugo deployment

- **Endpoint:** `wss://ws.k8s.abeon.app/connection/websocket`
- **HMAC token secret** (`CENTRIFUGO_TOKEN_SECRET`, HS256): in the **gitignored**
  file `docs/centrifungo.md` (repo root). **Never commit it.** The bridge/live test
  read it from the env var of the same name.
- **Namespaces config:** `k8s/k8s-projects/production/cust1004-tools/centrifugo/centrifugo-config.yaml`
  (ConfigMap `centrifugo-cust1004-tools-config`, ns `cs-app-cust1004-tools`,
  deployment `centrifugo-websocket`). Defines `abeon-cloud-cmd` (allow_subscribe_for_client),
  `abeon-cloud-sess` / `abeon-cloud-dev` (allow_subscribe_for_client + allow_publish_for_client
  — the desktop publishes without subscribing).
- **Config reload:** Centrifugo reads config at startup → after editing the
  ConfigMap, `kubectl apply` **and** `kubectl -n cs-app-cust1004-tools rollout restart deploy centrifugo-websocket`.
- **Multi-tenant caveat:** current permissions are permissive (`allow_*_for_client`).
  Tighten with per-channel subscription tokens + owner-scoped namespaces before
  multiple users.

## How to run / test (from `DesktopApp/`)

```bash
npm install && npm run tauri dev        # full app
npm run test:rust                       # cargo test (183 pass)
npm run lint                            # tsc --noEmit (zero errors)
```
Live Centrifugo smoke test (needs the secret + network):
```bash
CENTRIFUGO_TOKEN_SECRET=$(grep CENTRIFUGO_TOKEN_SECRET docs/centrifungo.md | cut -d= -f2) \
CENTRIFUGO_WS_URL=wss://ws.k8s.abeon.app/connection/websocket \
cargo test --manifest-path DesktopApp/src-tauri/Cargo.toml live_centrifugo_smoke -- --ignored --nocapture
```
Enabling the bridge at runtime: set the `remoteBridgeEnabled` setting to `"true"`
and provide `CENTRIFUGO_TOKEN_SECRET` in the app's env. Off by default. Remote
process spawn (`resumeSession`) additionally requires the `allowRemoteSpawn` setting.

## Remaining work — how to start each

### #3 CloudService (recommended next)
A small backend (language open; Rust/axum or Node both fine). Responsibilities:
- **Device pairing**: desktop shows a one-time code/QR → mobile exchanges it for a
  long-lived device credential.
- **Token minting**: issue short-lived Centrifugo connection + (if channels get
  gated) subscription JWTs, HS256 with `CENTRIFUGO_TOKEN_SECRET`. Move minting off
  the desktop (desktop currently self-mints for testing — see `remote/token.rs` for
  the exact claim shape).
- **Command authorization**: validate an upstream command, then publish it to
  `abeon-cloud-cmd:<device>` via the Centrifugo **server API**. This is the single
  authz checkpoint; multi-tenant RBAC goes here.
Start by reading the design doc's "Channel topology" + "Security" sections.

### #4 MobileApp (React Native / Expo)
Centrifugo JS client (subscribe `abeon-cloud-sess:*` / `abeon-cloud-dev:*`, read
only) + REST to CloudService (pairing, token). Reuse the contract: the TS types in
`DesktopApp/src/types/RemoteCommand.ts` etc. are generated from the Rust contract —
share or copy them. UI: high-level actions (prompt/approve/deny/stop), session list
+ live history, resume.

### Smaller follow-ups
- **ws client reconnect/backoff** — currently a single connection (no auto-reconnect).
  Algorithm sketch in research §6.
- **`pty:exit` is wired** to unbind the registry; verify under real disconnects.
- **Settings UI toggles** for `remoteBridgeEnabled` / `allowRemoteSpawn` (add to
  `PERSISTED_KEYS` in `DesktopApp/src/store/index.ts` + SettingsDialog).
- **Tighten Centrifugo namespaces** for multi-tenant (see above).

## Conventions & gotchas (don't relearn the hard way)

- Read **`DesktopApp/CLAUDE.md`** before touching desktop code (xterm/PTY gotchas,
  ts-rs, settings persistence, the deliberate `bash -c` PTY runner for nvm/PATH).
- **ts-rs types** are generated into `src/types/` during `cargo test`, not `cargo build`.
- **Network input is validated** at `validation.rs` (session_id/model allowlists) —
  keep that boundary when adding remote-reachable paths.
- **Commits:** Conventional Commits, scope by sub-app (`feat(remote):`...), no
  co-author trailer. English identifiers; Polish for user-facing UI text.
- **Don't move Tauri's `target/`** — it bakes absolute paths; `cargo clean` + rebuild.

## Reference docs (the deep dives)

- Design contract: `docs/superpowers/specs/2026-05-30-abeoncloud-remote-bridge-design.md`
- Plans: `docs/superpowers/plans/2026-05-30-remote-bridge-core.md` (2a),
  `…-2b-alpha.md`, `…-2b-beta.md`
- Centrifugo client research (protocol frames, crate assessment, live findings §7a):
  `docs/superpowers/research/2026-05-30-centrifugo-rust-client.md`
