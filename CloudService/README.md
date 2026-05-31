# CloudService

Auth/pairing + command-authorization microservice for AbeonCloud. Mints Centrifugo
JWTs, pairs phones to desktops, and is the single server-side checkpoint that
publishes authorized commands to `abeon-cloud-cmd:<deviceId>`.

See the design: `../docs/superpowers/specs/2026-05-30-abeoncloud-cloudservice-design.md`.

## Endpoints

| Method | Path             | Auth            | Purpose                                  |
|--------|------------------|-----------------|------------------------------------------|
| POST   | `/v1/devices`    | none            | Desktop first-boot registration          |
| POST   | `/v1/token`      | device or phone | Mint a short-lived Centrifugo connection JWT |
| POST   | `/v1/pair/start` | device          | Mint a one-time pairing code (QR)        |
| POST   | `/v1/pair/claim` | none            | Phone redeems a code → phone token       |
| POST   | `/v1/command`    | phone           | Validate + presence-gate + publish a command |
| POST   | `/v1/push-token` | phone           | Register the phone's Expo push token     |
| POST   | `/v1/notify`     | device          | Trigger a push to the paired phone (best-effort) |
| GET    | `/healthz`       | none            | Liveness                                 |
| GET    | `/readyz`        | none            | Readiness (DB ping)                      |

## Configuration (env)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `DATABASE_URL` | yes | — | MariaDB DSN `mysql://user:pass@host/db` |
| `CENTRIFUGO_TOKEN_SECRET` | yes | — | HS256 secret for minting JWTs |
| `CENTRIFUGO_API_KEY` | yes | — | Centrifugo server-API key |
| `CENTRIFUGO_API_URL` | yes | — | In-cluster Centrifugo HTTP base, e.g. `http://centrifugo-websocket.cs-app-cust1004-tools:8000` |
| `BIND_ADDR` | no | `0.0.0.0:8080` | listen address |
| `TOKEN_TTL_SECS` | no | `3600` | JWT lifetime |
| `PAIRING_TTL_SECS` | no | `300` | pairing-code lifetime |
| `EXPO_PUSH_URL` | no | `https://exp.host` | Expo Push API base for `/v1/notify`. No API key needed for Expo-managed push tokens. Override only for a proxy/self-host. |

> **Push (`/v1/notify`)** is best-effort and triggered by the desktop when a session enters
> the "waiting for user" state (`SessionActivity::WaitingUser` — there is no permission-specific
> signal; the push reads as "a session is waiting for you", de-duplicated per transition). It
> needs no new secret. For k8s, add `EXPO_PUSH_URL` to the `cloudservice-config` ConfigMap only
> if overriding the default.

## Develop / test

```bash
cargo build  --manifest-path CloudService/Cargo.toml
cargo test   --manifest-path CloudService/Cargo.toml          # unit + integration (fakes; no DB/network)

# MariaDB-backed store test (needs a live DB):
TEST_DATABASE_URL=mysql://user:pass@127.0.0.1/cloudservice_test \
  cargo test --manifest-path CloudService/Cargo.toml mysql -- --ignored --nocapture
```

## Docker

```bash
# build context is the repo root (path-dependency on ../crates/abeon-remote-core)
docker build -f CloudService/Dockerfile -t cloudservice:dev .
```
