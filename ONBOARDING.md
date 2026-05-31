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
| `CloudService/` | Auth/pairing + command-authorization microservice | **implemented (#3) — only k8s deploy pending** |
| `MobileApp/` | React Native / Expo client (Expo SDK 56, managed) | **MVP feature-complete (#4) — spec + Plans 1–3 implemented and merged; only EAS build/store + device QA remain** |
| `crates/abeon-remote-core/` | Shared Rust contract crate (protocol/validation/token/channels) | **done — used by desktop + CloudService** |
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

> **Update (2026-05-30): #3 CloudService is implemented and green.** The contract
> was extracted into a shared crate `crates/abeon-remote-core` (protocol, validation,
> token minting, channel helpers) consumed by BOTH the desktop (via facades) and the
> new `CloudService/` axum service. CloudService does device registration, pairing,
> Centrifugo JWT minting, and presence-gated command authorization. The desktop now
> registers on boot and fetches its token from `/v1/token` (legacy self-mint kept as
> a fallback when `cloudServiceUrl` is unset). Tests green: abeon-remote-core 17,
> CloudService 5 unit + 5 integration, desktop 172 (+1 ignored), lint clean.
> Remaining for #3: deploy the Docker image to k8s. Next sub-project: **#4 MobileApp**.

> **Update (2026-05-31): #4 MobileApp design + Foundation landed.** Three HTML design
> mockups were produced (`MobileApp/design/`); direction **v2 "Ewolucja marki"** was
> chosen. The full design spec is in `docs/superpowers/specs/2026-05-31-abeoncloud-mobileapp-design.md`.
> It is split into three plans, **all now implemented and merged to `main`**
> (`docs/superpowers/plans/2026-05-31-mobileapp-{1,2,3}-*.md`):
> - **Plan 1 (Foundation):** Expo SDK 56 managed app (expo-router + Zustand), v2 theme +
>   fonts, CloudService REST client, expo-secure-store creds, auth slice, auth-gated tab
>   shell, QR pairing, shared contract types via ts-rs into `MobileApp/src/types/`.
> - **Plan 2 (Sessions & control):** typed `SessionEvent` in the contract (reusing
>   HistoryBlock/SessionActivity/UsageSummary; double-wrap fixed), `centrifuge` subscribe
>   + parse, sessions/connection slices, session list + live history + commands
>   (prompt/approve/deny/stop/resume), reconnect/resync via Centrifugo history.
> - **Plan 3 (Push):** CloudService `expo_push_token` storage + `ExpoApi` client +
>   `/v1/push-token` & `/v1/notify`; desktop notify hook on `WaitingUser` (best-effort,
>   deduped); mobile Expo-token registration + deep-link on tap.
>
> Tests green across the board: MobileApp 35 jest + tsc clean, CloudService 15, Desktop 178.
> Remaining for #4: EAS build + store submission + on-device QA (no more core code).
> Read `MobileApp/CLAUDE.md` before working there (Node 22, `jest-expo/web` preset,
> jest pinned 30.4.0, the ts-rs `export_to_string` mechanism — all hard-won).

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
RBAC will live). CloudService now exists and owns token minting + authz; the desktop
self-mint path remains only as a fallback/test path when `cloudServiceUrl` is unset.

**Command/event contract** (Rust `#[derive(TS)]`, exported to `DesktopApp/src/types/`):
- `RemoteCommand` = `sendPrompt | approvePermission | denyPermission | stopSession | resumeSession`
- `RemoteEvent::cmdResult` (ack) + session mirror events (append/activity/title/usage)
- **Now defined in `crates/abeon-remote-core/src/protocol.rs`** (the shared crate),
  re-exported by `DesktopApp/src-tauri/src/remote/protocol.rs` and used by CloudService.
  The desktop translates these into PTY actions; it never exposes raw terminal bytes
  to the network. **For #4, reuse the generated TS** in `DesktopApp/src/types/`
  (`RemoteCommand.ts`, `RemoteEnvelope.ts`, `RemoteEvent.ts`).

**Design principle:** single-user now, **multi-tenant-ready**. Channel namespaces
(`abeon-cloud-cmd/sess/dev`) gain an owner prefix later; the auth checkpoint is
already isolated in (future) CloudService.

## Where the desktop code lives (`DesktopApp/src-tauri/src/`)

| File | Responsibility |
|------|----------------|
| `remote/protocol.rs` | **Facade** — `pub use abeon_remote_core::protocol::*` (contract now in the shared crate). |
| `remote/cloud_client.rs` | Async `reqwest` client for CloudService (`register` / `fetch_token` / `pair_start`). |
| `remote/registry.rs` | `SessionPtyRegistry` — `sessionId → ptyId`. |
| `remote/dispatch.rs` | Pure `command_to_action` + `PtyAction` + `session_to_bind`. **The approve/deny key sequences live here** (`APPROVE_KEYS="\r"`, `DENY_KEYS="\x1b"`) — confirm against the real Claude TUI. |
| `remote/wire.rs` | Centrifugo JSON wire codec (encode/parse, ping). |
| `remote/client.rs` | `CentrifugoClient` trait + `FakeCentrifugoClient`. |
| `remote/ws_client.rs` | Real `tokio-tungstenite` client (rustls+ring) + mock-server test + gated live test. |
| `remote/bus.rs` | `RemoteEventBus` (tokio broadcast); tapped by `sessions/watcher.rs`. |
| `remote/bridge.rs` | `RemoteBridge::{handle_envelope, run}`, `PtyActuator` trait + `AppPtyActuator`, channel helpers `{cmd,result,session}_channel`. |
| `remote/token.rs` | **Facade** — `pub use abeon_remote_core::token::*` (self-mint, fallback/test only). |
| `remote/startup.rs` | Startup wiring; CloudService register+token when `cloudServiceUrl` set, else legacy self-mint. Gated by `remoteBridgeEnabled`. |
| `commands/remote.rs` | `remote_pair_start` Tauri command (backs `PairingDialog.tsx`). |
| `validation.rs` | **Facade** — adapts `abeon_remote_core::validation` to `AppError::InvalidInput`. |

**CloudService code** lives in `CloudService/src/` (axum): `routes/{devices,token,pairing,command,health}.rs`,
`store/{mod,mysql}.rs` (traits + in-memory fakes + sqlx MariaDB), `centrifugo.rs` (server-API client),
`auth.rs` (bearer extractors), `crypto.rs`, `config.rs`, `error.rs`; `migrations/`, `k8s/`, `Dockerfile`.
See `CloudService/README.md` for the endpoint + env-var tables.

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
npm run test:rust                       # cargo test (172 pass, 1 ignored)
npm run lint                            # tsc --noEmit (zero errors)
```
CloudService + shared crate tests (from repo root):
```bash
cargo test --manifest-path crates/abeon-remote-core/Cargo.toml   # 17 pass
cargo test --manifest-path CloudService/Cargo.toml               # 5 unit + 5 integration (MariaDB test ignored)
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

### #3 CloudService — DONE (code), k8s deploy pending
Implemented per `docs/superpowers/specs/2026-05-30-abeoncloud-cloudservice-design.md`
and `docs/superpowers/plans/2026-05-30-cloudservice-{1,2,3}-*.md`. Only deployment
remains (NOT code), in the **separate k8s repo**:
- Build/push the image (`docker build -f CloudService/Dockerfile -t <tag> .` from repo root).
- Apply `CloudService/k8s/{deployment,service,ingress}.yaml`; create the secret
  `cloudservice-secrets` (`DATABASE_URL`, `CENTRIFUGO_TOKEN_SECRET`, `CENTRIFUGO_API_KEY`)
  and ConfigMap `cloudservice-config` (`CENTRIFUGO_API_URL` = in-cluster Centrifugo HTTP).
- Confirm Centrifugo's **server `api_key` is enabled** and set **`presence: true`** on the
  `abeon-cloud-cmd` namespace (required for the command presence gate).

### #4 MobileApp (React Native / Expo) — IN PROGRESS

Design is settled and the Foundation is built. **All design forks are resolved** (see
the spec `docs/superpowers/specs/2026-05-31-abeoncloud-mobileapp-design.md`): Expo
**managed** + EAS · **expo-router** + **Zustand** · `centrifuge` JS client ·
`expo-secure-store` / `expo-camera` · contract types **generated by ts-rs into
`MobileApp/src/types/`** · **push for permission prompts in MVP** via Approach A
(desktop → CloudService `/v1/notify` → Expo Push API).

**Plans (`docs/superpowers/plans/2026-05-31-mobileapp-{1,2,3}-*.md`):**
- **Plan 1 — Foundation: DONE (merged).** Scaffold, theme, contract export, REST client,
  secure-store, auth slice, auth gate + tab shell, QR pairing.
- **Plan 2 — Sessions & control: DONE (merged).** Typed `SessionEvent` (defined in the
  desktop `domain/session_event.rs`, reusing `HistoryBlock`/`SessionActivity`/`UsageSummary`,
  double-wrap fixed, exported to both apps' `src/types/`), `centrifuge` subscribe + parse,
  sessions/connection slices, session list + live history + commands, reconnect/resync.
- **Plan 3 — Push: DONE (merged).** CloudService push-token storage + `ExpoApi` +
  `/v1/push-token` & `/v1/notify`; desktop notify hook on `WaitingUser` (best-effort,
  deduped); mobile Expo-token registration + deep-link on tap.

**The API it consumes is fixed** (see `CloudService/README.md`):
- `POST /v1/pair/claim {code}` → `{ phoneToken, deviceId }`; `POST /v1/token`
  (Bearer `phoneToken`) → `{ token, expiresInSecs }`; `POST /v1/command`
  (Bearer `phoneToken`, body `RemoteEnvelope`) → `202 { published }`.
- Subscribe **read-only** with the JWT to `abeon-cloud-sess:<sessionId>` and
  `abeon-cloud-dev:<deviceId>`.

**Two findings carried into Plan 2/3 (don't relearn):**
- The desktop's session mirror events are **untyped `serde_json::Value`** today, and the
  `sessionAppend` payload is **double-wrapped** (`{ "blocks": { "blocks": [...] } }`,
  `watcher.rs`). Plan 2 promotes them to a typed `SessionEvent` and flattens the wrap.
- There is **no permission-specific signal** on the desktop; the closest proxy is
  `SessionActivity::WaitingUser` (fires on any turn-end). Plan 3 triggers push on that,
  with per-session dedup — so the push reads as "session waiting for you," not strictly
  "permission request."

> To continue: read `MobileApp/CLAUDE.md`, then execute Plan 2 (then Plan 3) via
> subagent-driven-development, the same path Plan 1 took.

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
- **ts-rs types** are generated into `DesktopApp/src/types/` during `cargo test`, not
  `cargo build`. The remote-contract types now live in `crates/abeon-remote-core`;
  regenerate with `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`. The
  `export_to` path is `../../../DesktopApp/src/types/` (three levels — ts-rs 11.1; `../../`
  silently writes to a stray `crates/DesktopApp/`). After regen, verify BOTH `git status
  DesktopApp/src/types` is clean AND no `crates/DesktopApp/` appeared.
- **Network input is validated** at `validation.rs` (session_id/model allowlists) —
  keep that boundary when adding remote-reachable paths.
- **Commits:** Conventional Commits, scope by sub-app (`feat(remote):`...), no
  co-author trailer. English identifiers; Polish for user-facing UI text.
- **Don't move Tauri's `target/`** — it bakes absolute paths; `cargo clean` + rebuild.

## Reference docs (the deep dives)

- Remote-bridge design contract: `docs/superpowers/specs/2026-05-30-abeoncloud-remote-bridge-design.md`
- Remote-bridge plans: `docs/superpowers/plans/2026-05-30-remote-bridge-core.md` (2a),
  `…-2b-alpha.md`, `…-2b-beta.md`
- **CloudService design**: `docs/superpowers/specs/2026-05-30-abeoncloud-cloudservice-design.md`
- **CloudService plans**: `docs/superpowers/plans/2026-05-30-cloudservice-1-shared-crate.md`
  (shared crate), `…-2-backend.md` (axum service), `…-3-desktop-integration.md` (desktop wiring)
- **CloudService API + config**: `CloudService/README.md`
- Centrifugo client research (protocol frames, crate assessment, live findings §7a):
  `docs/superpowers/research/2026-05-30-centrifugo-rust-client.md`
