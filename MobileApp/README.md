# MobileApp (planned)

React Native / Expo client for AbeonCloud. Connects to Centrifugo to:

- view active AI-CLI sessions and their live history/activity,
- issue high-level commands (send prompt, approve/deny permission, stop),
- resume sessions (remote process start, behind an explicit allow gate).

It is a Centrifugo client plus a REST client to `CloudService` (device pairing,
token retrieval). It speaks the contract defined by the desktop bridge
(`RemoteCommand` / `RemoteEvent`), generated via ts-rs in `DesktopApp/src/types/`.

See `docs/superpowers/specs/2026-05-30-abeoncloud-remote-bridge-design.md`.

Status: not started — directory scaffolded for the upcoming sub-project.
