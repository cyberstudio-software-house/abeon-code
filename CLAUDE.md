# AbeonCode / AbeonCloud — monorepo

This repository hosts the AbeonCode desktop app and the AbeonCloud remote-control
system that lets a mobile app drive AI-CLI coding sessions running on a desktop,
relayed through Centrifugo.

## Layout

- `DesktopApp/` — the Tauri 2 + React desktop app (the original AbeonCode). **Has
  its own detailed `DesktopApp/CLAUDE.md`** — read it before working there.
- `MobileApp/` — React Native / Expo client (planned). Issues high-level commands
  and views/continues sessions remotely.
- `CloudService/` — auth/pairing microservice (planned): device pairing, Centrifugo
  JWT minting, and server-side authorization of upstream commands.
- `docs/superpowers/` — project-wide specs and implementation plans (shared across
  all sub-apps, not app-specific).

Centrifugo itself is external infrastructure (already deployed), not code in this repo.

## Where to work

- Desktop app code, commands, build/test → `DesktopApp/` (run npm/cargo from there).
- Remote bridge design and roadmap → `docs/superpowers/specs/2026-05-30-abeoncloud-remote-bridge-design.md`.

## Conventions (repo-wide)

- **Commits**: Conventional Commits 1.0.0 (`feat(scope):`, `fix(scope):`, ...). No
  co-author trailer. Scope to the touched sub-app where useful (e.g. `feat(remote):`).
- **Language**: identifiers in English only. User-facing UI text in Polish.
- Per-app stacks, gotchas, and detailed conventions live in each app's own CLAUDE.md.
