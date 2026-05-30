# AbeonCloud — CloudService (Design)

**Date:** 2026-05-30
**Status:** Approved (design) — pending spec review before planning
**Scope:** Sub-project #3 (CloudService) **plus** the DesktopApp integration required to
use it end-to-end. Builds on the completed Desktop Bridge (#2) and the shared
command/event contract.

## Goal

Stand up the AbeonCloud auth/pairing/authorization backend and wire the desktop to
use it, so that:

- the desktop obtains its identity and short-lived Centrifugo tokens from a server
  (it stops self-minting and no longer holds the HMAC secret),
- a phone can pair with a desktop via a one-time code/QR and receive a long-lived
  credential,
- upstream commands flow through a single server-side authorization checkpoint before
  being published to the desktop's command channel.

This is the single authorization checkpoint and the natural home for later
multi-tenant RBAC.

## Decisions (locked)

1. **Scope:** full CloudService (pairing + token minting + command authorization) with
   real persistence, **plus** the DesktopApp changes to actually use it (register on
   boot, fetch tokens from the service, pairing QR dialog). End-to-end pairing works.
2. **Runtime:** Rust + axum, shipped as a **distroless Docker image** deployed on k8s
   next to the existing Centrifugo (namespace `cs-app-cust1004-tools`).
3. **Persistence:** existing in-cluster **MariaDB**, accessed via `sqlx`. Service stays
   **stateless** (no PVC; supports rolling updates and >1 replica).
4. **Secret custody:** `CENTRIFUGO_TOKEN_SECRET` lives **only in CloudService**, never on
   desktops. Desktops hold their own `deviceSecret` and trade it for short-lived
   Centrifugo JWTs.
5. **Contract reuse:** extract the command/token contract into a shared Rust crate that
   both the desktop and CloudService depend on, so the two can never drift.
6. **Presence gate:** before publishing a command, CloudService checks Centrifugo
   presence and rejects with `409` if the target desktop is offline.

## Actors & responsibilities

The `<deviceId>` in `abeon-cloud-{cmd,sess,dev}:<deviceId>` is **the desktop**. A phone
*controls* a desktop.

| Actor        | Auth it holds                                  | What it does                                                            |
|--------------|------------------------------------------------|-------------------------------------------------------------------------|
| **Desktop**  | `deviceSecret` (from registration)             | registers once; fetches short-lived Centrifugo JWTs; starts pairing     |
| **Phone**    | `phoneToken` (from pairing)                     | claims a pairing code; fetches read-only Centrifugo JWTs; sends commands|
| **CloudService** | `CENTRIFUGO_TOKEN_SECRET` + `CENTRIFUGO_API_KEY` | sole holder of the secrets; mints JWTs, authorizes & publishes commands |

## Architecture

```
Desktop (Tauri)                         CloudService (Rust/axum, k8s)        Phone (RN/Expo, #4)
  POST /v1/devices  ───register──▶  ┌──────────────────────────────┐
   ◀── {deviceId, deviceSecret}     │  MariaDB: devices,            │
  POST /v1/token   ───────────────▶ │           phone_tokens,       │  ◀── POST /v1/pair/claim {code}
   ◀── Centrifugo JWT               │           pairing_codes       │      {phoneToken, deviceId}
  POST /v1/pair/start ────────────▶ │                               │  ◀── POST /v1/token  → read JWT
   ◀── {code}  (shown as QR)        │  Centrifugo server API:       │  ◀── POST /v1/command {envelope}
                                    │   publish + presence (in-     │
  (subscribes abeon-cloud-cmd:<id>, │    cluster HTTP, X-API-Key)   │
   publishes sess:/dev: as a        └───────────────┬──────────────┘
   Centrifugo WS client)                            │ publish to abeon-cloud-cmd:<deviceId>
                                                     ▼
                                                 Centrifugo ──cmd──▶ Desktop
```

Downstream events (desktop → mobile) bypass CloudService and go directly through
Centrifugo. Only upstream commands and token/pairing are gated here.

## HTTP API

All paths under `/v1/` so the contract can version without breaking paired phones.

```
POST /v1/devices        (unauth, first boot)            → { deviceId, deviceSecret }
POST /v1/token          (Bearer deviceSecret | phoneToken) → { token, expiresInSecs }
POST /v1/pair/start     (Bearer deviceSecret)           → { code, expiresInSecs }
POST /v1/pair/claim     (unauth, body { code })         → { phoneToken, deviceId }
POST /v1/command        (Bearer phoneToken, body: RemoteEnvelope)
                                                        → 202 { published } | 4xx { error }
GET  /healthz                                           → liveness
GET  /readyz                                            → readiness (DB + config reachable)
```

`/v1/token` returns a Centrifugo **connection** JWT: `sub = deviceId` for desktops,
`sub = phone:<phoneId>` for phones, short TTL (~1h).

## Security model (MVP single-user, multi-tenant-ready)

- **API credentials** (`deviceSecret`, `phoneToken`): opaque 256-bit random tokens, sent
  as `Authorization: Bearer`. Stored **hashed at rest with SHA-256** — these are
  high-entropy random tokens, so a fast hash is correct; argon2 is for low-entropy human
  passwords, which we do not have. Comparison is constant-time. Revocation = delete the
  row.
- **Centrifugo JWTs** (`/v1/token`): the existing `{ sub, exp, channel? }` HS256 claim
  shape, minted from `CENTRIFUGO_TOKEN_SECRET`. Connection tokens only for now (the
  namespaces are still permissive `allow_*_for_client`); per-channel subscription tokens
  are the multi-tenant follow-up.
- **Command authorization** (`/v1/command`): (1) `phoneToken` valid → resolves to its
  bound `deviceId`; (2) envelope validated via the **shared protocol crate** (same
  `validate_session_id` / `validate_model` rules as the desktop's network trust
  boundary); (3) presence check; (4) publish to `abeon-cloud-cmd:<deviceId>`. A phone can
  only ever command its own paired desktop.
- `resumeSession`'s real gate stays **desktop-side** (`allowRemoteSpawn` setting + the
  returning `cmdResult` ACK). CloudService does not duplicate it.

## Pairing flow

```
Desktop ──POST /v1/pair/start──▶ CloudService
   code: 8-char base32, single-use, TTL 5 min, stored hashed, bound to deviceId
Desktop shows QR(code)
Phone scans ──POST /v1/pair/claim { code }──▶ CloudService
   → issues phoneToken bound to deviceId, deletes the code
```

## Centrifugo integration

- **Mint** (downstream tokens): reuse `mint_connection_token` from the shared crate
  (HMAC `CENTRIFUGO_TOKEN_SECRET`).
- **Publish** (upstream commands): Centrifugo **server HTTP API** —
  `POST {CENTRIFUGO_API_URL}/api`, header `X-API-Key: {CENTRIFUGO_API_KEY}`, body
  `{ method: "publish", params: { channel, data } }`. CloudService reaches Centrifugo
  over the **in-cluster Service** (e.g. `http://centrifugo-websocket.cs-app-cust1004-tools:8000`),
  not the public `wss://` — keeping the privileged API key off the public internet.
- **Presence gate:** before publishing, CloudService calls the presence API on the
  desktop's channel; if the desktop is not connected, it returns `409 desktop offline`
  rather than publishing into the void. Requires `presence: true` on the
  `abeon-cloud-cmd` namespace.

## Data model (MariaDB, via `sqlx`)

```sql
devices(
  id            CHAR(36) PRIMARY KEY,         -- deviceId (uuid)
  device_secret_hash CHAR(64) NOT NULL,       -- sha256 hex
  label         VARCHAR(128) NULL,
  created_at    DATETIME NOT NULL,
  last_seen_at  DATETIME NULL
)

phone_tokens(
  id            CHAR(36) PRIMARY KEY,         -- phoneId
  device_id     CHAR(36) NOT NULL,            -- FK devices.id
  token_hash    CHAR(64) NOT NULL,
  label         VARCHAR(128) NULL,
  created_at    DATETIME NOT NULL,
  last_used_at  DATETIME NULL
)

pairing_codes(
  code_hash     CHAR(64) PRIMARY KEY,         -- sha256 of the one-time code
  device_id     CHAR(36) NOT NULL,            -- FK devices.id
  expires_at    DATETIME NOT NULL,            -- single-use, short TTL
  created_at    DATETIME NOT NULL
)
```

## Shared crate (anti-drift)

Extract the contract into a standalone lib crate both apps depend on by **path** — no
single mega-workspace, to avoid relocating Tauri's `target/` (a known DesktopApp gotcha).

```
crates/abeon-remote-core/                # new standalone lib crate
  protocol.rs    ← moved from DesktopApp/src-tauri/src/remote/protocol.rs
  validation.rs  ← moved from DesktopApp/src-tauri/src/validation.rs
  token.rs       ← moved from DesktopApp/src-tauri/src/remote/token.rs
```

- `DesktopApp/src-tauri/Cargo.toml`: `abeon-remote-core = { path = "../../crates/abeon-remote-core" }`.
  The old module paths (`remote/protocol.rs`, `validation.rs`, `remote/token.rs`) become
  thin re-export facades (`pub use abeon_remote_core::...::*;`) so existing call sites and
  the `bridge.rs` channel helpers do not move.
- ts-rs `export_to` is retargeted so generated TS still lands in `DesktopApp/src/types/`;
  verified by running `cargo test` once (ts-rs exports on test, not build).
- CloudService depends on the same crate → one definition of command validation and JWT
  claims across desktop and service.

## CloudService crate layout (axum)

```
CloudService/
  Cargo.toml
  Dockerfile
  src/
    main.rs        # axum router, config, sqlx pool, graceful shutdown
    config.rs      # typed env: DATABASE_URL, CENTRIFUGO_{TOKEN_SECRET,API_KEY,API_URL}, BIND_ADDR
    error.rs       # AppError → JSON + status (no internal leakage)
    auth.rs        # Bearer extractor; hash + constant-time compare; resolves device/phone
    routes/
      devices.rs   # POST /v1/devices
      token.rs     # POST /v1/token
      pairing.rs   # POST /v1/pair/{start,claim}
      command.rs   # POST /v1/command  (validate → presence-check → publish)
      health.rs    # /healthz /readyz
    store/
      mod.rs       # DeviceStore + PhoneTokenStore + PairingStore traits
      mysql.rs     # sqlx MariaDB impls
    centrifugo.rs  # server-API client: publish + presence (reqwest)
  migrations/      # sqlx migrations (the 3 tables)
```

Storage and the Centrifugo client sit behind traits so handlers are testable against
in-memory / fake implementations (mirrors how the desktop tests `CentrifugoClient`).

## Desktop-side integration (`DesktopApp/`)

- `remote/cloud_client.rs` (new): thin `reqwest` client — `register()`, `fetch_token()`,
  `pair_start()`.
- `remote/startup.rs`: on boot (bridge enabled) → register if no stored
  `deviceId`/`deviceSecret`; obtain the Centrifugo JWT via `/v1/token` instead of
  self-minting. Persist `deviceId`/`deviceSecret` in settings (SQLite) and add to
  `PERSISTED_KEYS`. New setting `cloudServiceUrl`.
- `token.rs` self-minting becomes test-only (kept for the gated live test; removed from
  the runtime path).
- **Pairing UI**: new `PairingDialog.tsx` — calls `pair_start` via a Tauri command,
  renders the code as a QR with Polish copy (e.g. "Zeskanuj kod telefonem, aby
  sparować"). Wired into `SettingsDialog` or a dedicated menu entry. New Tauri command +
  typed wrapper in `lib/tauri.ts` per the IPC convention.

## Deployment (Docker + k8s)

- **Dockerfile**: multi-stage — `rust:1-bookworm` builder → `gcr.io/distroless/cc-debian12`
  runtime. Single binary, non-root, ~25MB.
- **k8s** (manifests authored here under `CloudService/k8s/`; applied in the separate k8s
  repo, mirroring the Centrifugo layout): `Deployment` (stateless, `RollingUpdate`),
  `Service` (ClusterIP), `Secret` refs for `DATABASE_URL` / `CENTRIFUGO_TOKEN_SECRET` /
  `CENTRIFUGO_API_KEY`, `ConfigMap` for `CENTRIFUGO_API_URL` / `BIND_ADDR`,
  liveness/readiness on `/healthz` and `/readyz`.
- **Public exposure**: an `Ingress` at e.g. `https://cloud.k8s.abeon.app` so the phone
  (and the desktop) can reach the service. Centrifugo stays reachable over its existing
  `wss://` host.

## Error handling

- Auth failures → `401` with a generic body (no internal detail).
- Invalid envelope (validation crate rejects) → `400 { error }`.
- Expired/unknown pairing code → `400`.
- Target desktop offline (presence) → `409 desktop offline`.
- Centrifugo server-API failure → `502`; logged with context, generic body to caller.
- DB unavailable → `/readyz` fails so k8s stops routing; requests get `503`.

## Testing

- **Shared crate**: the existing protocol round-trip + validation tests move with it (no
  coverage loss).
- **CloudService**: handler tests against in-memory store fakes + a fake Centrifugo
  client; an `sqlx` migration test against a throwaway MariaDB (e.g. `testcontainers`);
  pairing happy-path and authorization-denial integration tests.
- **Desktop**: `cloud_client` tested against a mock HTTP server (mirrors the
  `ws_client` mock-server test). `npm run lint` and `npm run test:rust` stay green after
  the crate extraction.

## Risks / dependencies to confirm

1. **Centrifugo `api_key` + in-cluster URL** — defined in the separate k8s repo, not
   here. The Centrifugo server API must be enabled and the key provisioned as a secret.
2. **Namespace `presence: true`** on `abeon-cloud-cmd` for the presence gate — ConfigMap
   tweak + `kubectl rollout restart` (Centrifugo reads config at startup).
3. **Crate extraction touches the desktop build** — mitigated by the re-export facade;
   `cargo test` + `npm run lint` must stay green after the move.
4. **MariaDB reachability/credentials** from the namespace — provision the `DATABASE_URL`
   secret; confirm network policy allows the connection.

## Out of scope (YAGNI for now)

- Per-channel subscription tokens / owner-scoped namespaces (multi-tenant hardening).
- Multi-tenant accounts, RBAC, billing (architecture leaves room; not built now).
- MobileApp implementation (#4, separate spec) — this design only defines the API it
  will consume.
- Rate limiting / abuse protection beyond pairing-code TTL and single-use (revisit with
  public exposure hardening).
```
