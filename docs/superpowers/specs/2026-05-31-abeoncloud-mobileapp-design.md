# AbeonCloud — MobileApp (Design)

**Date:** 2026-05-31
**Status:** Approved (design) — pending spec review before planning
**Scope:** Sub-project #4 (MobileApp) — the React Native / Expo client that pairs with
a desktop, views live sessions, and issues high-level commands. **Plus** the small
CloudService and DesktopApp additions required to deliver **push notifications for
permission prompts** (chosen in-scope for MVP). Builds on the completed Desktop Bridge
(#2) and CloudService (#3); the command/event contract and CloudService REST API are
both already fixed.

## Goal

Ship a phone app that lets a user remotely supervise and drive AI-CLI coding sessions
running on their desktop, relayed through Centrifugo. From the phone the user can:

- pair with a desktop via a one-time QR code,
- see the list of active sessions with live status and token usage,
- open a session and follow its live history (prompts, assistant output, tool calls),
- act on the session — send a prompt, **approve / deny** a permission request, stop it,
  or resume it (gated),
- receive a **push notification** when a session is waiting for an approve/deny
  decision, even when the app is backgrounded.

The mobile app is a **read-mostly remote control**: it subscribes read-only to session
and device channels (high-volume event mirror) and writes only through CloudService
(low-volume, authorized commands). It never sees raw terminal bytes.

## Visual direction (locked)

Direction **v2 — "Ewolucja marki"** from the design exploration in
`MobileApp/design/` (`v1-faithful.html`, `v2-evolution.html`, `v3-bold.html`;
`index.html` is the chooser). v2 keeps the desktop's gold brand DNA but reinterprets it
as a premium mobile-native app:

- **Palette:** warm gold accent (`#b07c2e` light / `#e0ad57` dark) on warm paper /
  near-black, mirroring `DesktopApp/src/styles/globals.css` tokens.
- **Type:** `Fraunces` (serif display) for headers + `Geist` (body) + `Geist Mono`
  (code / identifiers).
- **Structure:** bottom tab bar (Sesje / Aktywność / Ustawienia), floating command bar,
  session cards with a token-usage bar, inline approve/deny.
- **Themes:** light and dark, following the OS (the desktop's `system` default).

Visual refinements (e.g. whether to adopt v3's alert-grade permission modal) are open
and will be settled during implementation; they do not change the architecture.

## Decisions (locked)

1. **Expo workflow:** **managed** + EAS Build. No `ios/`/`android/` dirs in the repo;
   `expo-camera`, `expo-secure-store`, `expo-notifications` all run under managed.
   Cloud builds via EAS; OTA updates available.
2. **Navigation + state:** **expo-router** (file-based) + **Zustand** (same store
   pattern as DesktopApp — slices composed into one store).
3. **Centrifugo client:** the **`centrifuge`** npm package (matches the JSON wire
   protocol the desktop uses).
4. **Contract type sharing:** **ts-rs generates the contract types directly into
   `MobileApp/src/types/`**, exactly as it already does for `DesktopApp/src/types/`.
   Rust (`crates/abeon-remote-core`) stays the single source of truth; one
   `cargo test` regenerates both. No manual copy, no separate npm package.
5. **Secure storage:** `phoneToken` and `deviceId` stored in **`expo-secure-store`**.
6. **Push notifications: in MVP.** Delivered via **Approach A — the desktop notifies
   CloudService**: when the desktop emits a "waiting for permission" event it also calls
   a new CloudService endpoint, which looks up the device's Expo push token and sends
   the push via the Expo Push API. (Alternatives — CloudService subscribing to
   Centrifugo, or a Centrifugo publish-proxy webhook — were rejected as more infra for
   no MVP benefit.)

## Actors & auth (recap from #3)

The `<deviceId>` in `abeon-cloud-{cmd,sess,dev}:<deviceId>` is **the desktop**. A phone
*controls* a desktop.

| Actor | Auth it holds | What it does (mobile-relevant) |
|-------|---------------|--------------------------------|
| **Phone** | `phoneToken` (from pairing) | claims a pairing code; fetches read-only Centrifugo JWTs; sends commands; registers its push token |
| **CloudService** | `CENTRIFUGO_TOKEN_SECRET` + `CENTRIFUGO_API_KEY` + Expo push (tokenless) | mints JWTs, authorizes & publishes commands, sends push |
| **Desktop** | `deviceSecret` | publishes session events; on a permission prompt, also pings CloudService to trigger push |

## Architecture

```
Phone (RN / Expo)                  CloudService (Rust/axum, k8s)        Desktop (Tauri)
  scan QR ──POST /v1/pair/claim──▶  ┌───────────────────────────┐
   ◀── {phoneToken, deviceId}       │  devices, phone_tokens,    │
  POST /v1/token ─────────────────▶ │  pairing_codes,            │
   ◀── Centrifugo read JWT          │  + push_tokens (new)       │
                                    │                            │
  centrifuge WS (read-only) ──subscribe──▶ abeon-cloud-sess:<id> ◀──publish events── bridge
                            ──subscribe──▶ abeon-cloud-dev:<dev>  ◀──publish cmdResult─ bridge
                                    │                            │
  POST /v1/command ───────────────▶│ authz + presence gate ─────┼──publish──▶ abeon-cloud-cmd:<dev> ──▶ bridge
                                    │                            │
  POST /v1/push-token (new) ──────▶│ store Expo token           │
                                    │                            │
                                    │ ◀── POST /v1/notify (new) ──── desktop on "permission" event
                                    │ Expo Push API ──push──▶ Phone (OS notification)
```

**Flow asymmetry preserved:** session/device events flow desktop→Centrifugo→phone
directly (the phone subscribes read-only); commands flow phone→CloudService→Centrifugo→
desktop (the single authz checkpoint). Push is a *new, separate* server-triggered path
that does **not** put CloudService in the event stream — the desktop pokes it.

## Screens & navigation (expo-router)

File-based routes:

```
app/
  _layout.tsx              # root: theme, fonts, auth gate, push handler
  index.tsx                # redirect: paired → (tabs), else → /pair
  pair.tsx                 # modal-ish: QR scan → claim → store token
  (tabs)/
    _layout.tsx            # bottom tab bar (Sesje / Aktywność / Ustawienia)
    sessions.tsx           # session list (default tab)
    activity.tsx           # cross-session activity feed (waiting/working items)
    settings.tsx           # device info, theme, push toggle, sign out (unpair)
  session/[id].tsx         # live history + command bar + permission prompt
```

| Screen | Purpose | Key data |
|--------|---------|----------|
| **Pair** | Redeem desktop's QR | `expo-camera` → `POST /v1/pair/claim {code}` |
| **Sesje (list)** | All sessions, status, usage | `abeon-cloud-dev` + per-session `abeon-cloud-sess` events |
| **Aktywność** | Items needing attention (waiting) | derived from session state |
| **Session detail** | Live history + actions | `abeon-cloud-sess:<id>` stream |
| **Ustawienia** | Device, theme, push, unpair | local + secure-store |

## State (Zustand slices)

Single store composed from slices (DesktopApp pattern):

- **`authSlice`** — `phoneToken`, `deviceId`, `status: 'unpaired'|'paired'`; hydrated
  synchronously from `expo-secure-store` at boot. `pair()`, `unpair()`.
- **`connectionSlice`** — `centrifuge` instance lifecycle, connection state, JWT refresh,
  reconnect/backoff status.
- **`sessionsSlice`** — `Map<sessionId, Session>` (title, project, model, status, usage,
  lastActivityAt) + `Map<sessionId, HistoryBlock[]>`; updated by inbound `RemoteEvent`s.
- **`commandsSlice`** — outbound command queue: build `RemoteEnvelope`, `POST /v1/command`,
  track pending acks (correlate with inbound `cmdResult`).

Selectors over arrays/maps use shallow comparison (the DesktopApp `useShallow` lesson).

## Data flow

**Pairing.** Camera scans the desktop's QR (a one-time `code`) → `POST /v1/pair/claim
{code}` → `{phoneToken, deviceId}` persisted to secure-store → register push token →
navigate into tabs.

**Connect.** `POST /v1/token` (Bearer `phoneToken`) → short-lived Centrifugo JWT →
`centrifuge` connects → subscribe read-only to `abeon-cloud-dev:<deviceId>` (cmdResult
acks, presence) and, per opened/known session, `abeon-cloud-sess:<sessionId>`
(history/activity/title/usage). JWT is refreshed before expiry via the same endpoint.

**Commands.** UI action → build `RemoteEnvelope` (reuse generated TS) → `POST /v1/command`
(Bearer `phoneToken`) → `202 {published}`. The effect (e.g. approve sends the key
sequence on the desktop) is observed back as session events + a `cmdResult` ack. Resume
is gated server-side (`allowRemoteSpawn`); the UI reflects rejection.

**Resync on reconnect.** On (re)subscribe, use Centrifugo channel **history** to backfill
missed events, plus an on-demand snapshot of current session state. The list and any open
session reconcile from history rather than assuming a continuous stream.

## Push notifications (MVP) — Approach A

**Mobile side:**
- On pair (and on app start if granted), request notification permission via
  `expo-notifications`, obtain the **Expo push token**, and send it to CloudService:
  `POST /v1/push-token {expoPushToken}` (Bearer `phoneToken`).
- Foreground: in-app banner (no OS notification needed — the live stream already shows it).
- Background/quit: OS notification "Sesja czeka na zgodę: <title>". Tapping it
  deep-links (expo-router) to `session/[id]`.

**CloudService side (new):**
- New table/column: `push_tokens` (deviceId/phoneToken → Expo push token).
- New endpoint `POST /v1/push-token` (Bearer `phoneToken`) — upsert token.
- New endpoint `POST /v1/notify` — authenticated with the **same device credential the
  desktop already uses for `/v1/token`** (no new secret). Body identifies the session +
  reason `permissionRequested`; CloudService
  resolves the owning device's push token(s) and calls the **Expo Push API**
  (`https://exp.host/--/api/v2/push/send`, tokenless). Best-effort; failures logged, not
  fatal.

**Desktop side (new):**
- When the bridge emits the "waiting for permission" session event, it additionally calls
  CloudService `/v1/notify` via the existing `remote/cloud_client.rs` (only when
  `cloudServiceUrl` is set). This is a thin, best-effort fire-and-forget; the desktop
  stays push-agnostic beyond this one call.

> The exact desktop event that means "waiting for permission" must be confirmed against
> the live Claude TUI during planning/implementation — it is the same signal the
> approve/deny key sequences in `remote/dispatch.rs` respond to.

## Contract type sharing

`crates/abeon-remote-core` exports the contract into `MobileApp/src/types/` as a second
ts-rs target. Because `export_to` is single-target per type, this is done via an
`export_all_to(...)` call in a crate test (the desktop keeps its attribute target). MVP
commands/events reuse: `RemoteCommand.ts`, `RemoteEnvelope.ts`, `RemoteEvent.ts`.

> **Note (from code reading):** only `RemoteEvent::cmdResult` is a typed contract value.
> The **session mirror events** (`sessionAppend`/`sessionActivity`/`sessionTitle`/
> `sessionUsage`) are currently published as **ad-hoc JSON** by the desktop bridge
> (`encode_bus_event`), not as ts-rs types. Plan 2 resolves this — preferred direction:
> promote them into the `abeon-remote-core` contract as a typed `SessionEvent` enum so
> mobile consumes them typed and the desktop publishes typed JSON. The mobile data flow
> below assumes that typing lands in Plan 2.

Regeneration is the existing
`cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`; after regen, verify
both type dirs are updated and no stray dirs appear (the ts-rs path-depth gotcha from
onboarding). A thin hand-written `lib/api.ts` wraps the CloudService REST calls; a
`lib/centrifugo.ts` wraps subscribe/parse using the generated event types.

## Error handling

- **Token expiry / 401:** refresh Centrifugo JWT via `/v1/token`; if `phoneToken` itself
  is rejected, drop to the Pair screen (unpaired).
- **Desktop offline (command 409):** the presence gate rejects; show "Desktop offline" and
  disable command buttons until presence returns.
- **WS disconnect:** `connectionSlice` shows a reconnecting state; on reconnect, resync
  via history. Exponential backoff (mirrors the desktop ws reconnect sketch).
- **Resume rejected (gate off):** explain the desktop must allow remote spawn.
- **Push permission denied:** app still works in-foreground; Settings surfaces the denied
  state with a deep link to OS settings.
- **Network input validation:** all command payloads conform to the contract before
  `POST /v1/command`; CloudService remains the authoritative validator.

## Security boundaries

- `phoneToken` only in `expo-secure-store`, never in async-storage/logs.
- Phone holds **no** `CENTRIFUGO_TOKEN_SECRET`; it only ever receives short-lived,
  read-scoped JWTs from CloudService.
- Commands always go through CloudService authz; the phone cannot publish to command
  channels directly.
- Single-user now, **multi-tenant-ready**: channel namespaces gain an owner prefix later;
  no design choice here blocks that.

## Testing strategy

- **Unit (Jest + RN Testing Library):** slices (auth/sessions/commands reducers), event
  parsing into `HistoryBlock`s, envelope construction, reconnect/backoff logic.
- **Component:** session card states (waiting/working/idle), permission prompt
  approve/deny, command bar.
- **Integration (mocked):** a fake CloudService + fake `centrifuge` to exercise
  pair → connect → receive events → send command → ack, and the push registration call.
- **CloudService:** unit tests for `/v1/push-token` + `/v1/notify` (token resolution,
  Expo API call faked), consistent with the existing axum test style.
- **Manual/live:** end-to-end against production Centrifugo + a running desktop, mirroring
  the desktop's gated live smoke test.

## Out of scope (MVP)

- Multi-device / multi-user account management and RBAC (namespaces stay single-owner).
- Editing desktop settings from the phone.
- Rich terminal rendering / raw PTY bytes (the phone shows high-level history only).
- Offline command queueing (commands require a live, present desktop).
- Android/iOS store submission specifics (covered by a later release phase).

## Resolved forks (from onboarding §#4)

| Fork | Decision |
|------|----------|
| Expo managed vs bare | **managed + EAS** |
| Centrifugo JS client | **`centrifuge`** |
| Navigation + state | **expo-router + Zustand** |
| Contract type sharing | **ts-rs → `MobileApp/src/types/`** |
| Secure storage / QR | **expo-secure-store / expo-camera** |
| Push for permission prompts | **in MVP, Approach A (desktop → CloudService → Expo)** |
| Reconnect/resync | **Centrifugo history + on-demand snapshot, backoff** |

## Build sequence (preview — detailed in the plan)

1. Scaffold Expo managed app (expo-router, Zustand, fonts, theme tokens from v2).
2. ts-rs: add `MobileApp/src/types/` export target; wire `lib/api.ts` + `lib/centrifugo.ts`.
3. Pairing (camera → claim → secure-store) + auth gate.
4. Connection + session list (subscribe, render status/usage).
5. Session detail: live history + command bar + approve/deny.
6. Push: mobile registration + CloudService `/v1/push-token` & `/v1/notify` + desktop notify hook.
7. Reconnect/resync hardening + error states + tests.
