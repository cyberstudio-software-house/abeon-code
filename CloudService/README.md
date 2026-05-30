# CloudService (planned)

Small backend service for AbeonCloud. Responsibilities:

- **Device pairing** — exchange a one-time pairing code (shown by the desktop) for
  a long-lived device credential.
- **Centrifugo JWT minting** — issue short-lived connection + subscription tokens
  scoped to the owner's channels (`sess:`, `dev:`, `cmd:`).
- **Command authorization** — the single server-side checkpoint for upstream
  commands: validate, then publish to the desktop's `cmd:<device>` channel via the
  Centrifugo server API. This is where multi-tenant RBAC will later live.

Downstream events (desktop → mobile) bypass this service and go directly through
Centrifugo; only upstream commands are gated here.

See `docs/superpowers/specs/2026-05-30-abeoncloud-remote-bridge-design.md`.

Status: not started — directory scaffolded for the upcoming sub-project.
