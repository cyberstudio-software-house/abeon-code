# AbeonCloud MobileApp

React Native / **Expo SDK 56 (managed)** client for AbeonCloud. Pairs with a desktop via
QR, then remote-controls AI-CLI coding sessions: views the live session list + history,
sends high-level commands (prompt / approve / deny / stop / resume), and (Plan 3) gets a
push when a session is waiting for input. It is a `centrifuge` (Centrifugo) client plus a
REST client to `CloudService`. See `../ONBOARDING.md` and the spec
`../docs/superpowers/specs/2026-05-31-abeoncloud-mobileapp-design.md`.

> Expo changes fast — when touching native/config, check the versioned docs at
> https://docs.expo.dev/versions/v56.0.0/ .

## Stack quick map

- **Runtime:** Expo SDK 56, managed workflow (no `ios/`/`android/` dirs); EAS Build later.
- **Navigation:** `expo-router` (file-based, `app/`).
- **State:** `zustand` v5 — slices composed in `src/store/index.ts` (same pattern as DesktopApp).
- **Realtime:** `centrifuge` v5 (read-only subscriptions to `abeon-cloud-sess:<id>` and `abeon-cloud-dev:<deviceId>`).
- **Native:** `expo-camera` (QR), `expo-secure-store` (`phoneToken`/`deviceId`), `expo-notifications` (Plan 3 push), `@expo-google-fonts/*` (Fraunces + Geist + Geist Mono).
- **Tests:** Jest (`jest-expo/web` preset) + `@testing-library/react-native`.
- **Lint/type-check:** `npm run lint` (= `tsc --noEmit`).

## Folder map (`MobileApp/`)

- `app/` — expo-router routes. `_layout.tsx` (fonts + auth hydration gate) · `index.tsx`
  (redirect by pairing status) · `pair.tsx` (QR scan → claim) · `(tabs)/` (bottom nav:
  `sessions` / `activity` / `settings`).
- `src/lib/` — `config.ts` (URLs), `api.ts` (CloudService REST: claim/token/command),
  `secure.ts` (expo-secure-store wrapper), `nav.ts` (pure routing helpers), `pairing.ts`
  (QR code extraction + claim).
- `src/store/` — `authSlice.ts` (status/phoneToken/deviceId, pair/unpair/hydrate),
  `index.ts` (`createStore` vanilla factory for tests + `useStore` hook).
- `src/theme/` — `tokens.ts` (v2 brand light/dark token sets + `resolveTokens`).
- `src/types/` — **ts-rs-generated** contract types (`RemoteCommand`/`RemoteEnvelope`/`RemoteEvent`). **Do not edit by hand** (see below).
- `__tests__/` — jest specs mirroring `src/`.
- `design/` — the three HTML design mockups (v1/v2/v3); v2 is the chosen direction.

## Conventions

- **Language:** identifiers in English only. **User-facing UI text in Polish** (e.g. "Sesje", "Zatwierdź", "Odłącz").
- **Commits:** Conventional Commits 1.0.0, scope `feat(mobile):` / `fix(mobile):` / `build(mobile):`. No co-author trailer.
- **Contract types are Rust-owned:** `RemoteCommand`/`RemoteEnvelope`/`RemoteEvent` (and, after Plan 2, `SessionEvent`) are defined in `crates/abeon-remote-core` and generated into `src/types/`. Never hand-edit `src/types/`; change the Rust and regenerate.
- **Zustand selectors:** select fields **individually** (`useStore((s) => s.x)`), never return a new object/array from a selector without `useShallow` — it causes infinite re-renders (the DesktopApp gotcha).
- **Keep test targets pure:** put logic in `src/lib/*` pure modules so tests don't import the expo-router/RN runtime (see the jest gotcha below). `nav.ts`/`pairing.ts` exist for exactly this reason.

## Gotchas (hard-won — don't relearn)

- **Node 22 required.** The default shell node here is v18 (too old for Expo SDK 56). Use nvm: every npm/npx/node command must run under Node 22, e.g. `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" && npm run lint`. Shell state does not persist between commands.
- **Jest uses the `jest-expo/web` preset, NOT the default native preset.** The native preset loads Expo SDK 56's "winter" runtime, whose lazy global getters (`fetch`, …) fire a `require()` that trips jest 30's between-tests guard ("trying to require a file outside of the scope of the test code"). `jest-expo/web` (jsdom) avoids it and runs both pure-logic and react-native-web component tests.
- **Jest is pinned to `30.4.0`** via an `overrides` block in `package.json`. The registry's jest `30.4.2` is inconsistent (`jest-mock` only publishes to `30.4.1`), which crashes with `clearMocksOnScope is not a function`. Don't bump jest without checking the whole `@jest/*` family resolves to one coherent version.
- **`@/` path alias** is mapped in BOTH `tsconfig.json` (`paths`) and `jest.config.js` (`moduleNameMapper`) — jest does not read tsconfig paths. Keep them in sync.
- **`types: ["jest"]` in tsconfig** restricts ambient @types to jest (avoids @types/node global conflicts with RN's own `setTimeout`/etc.). Consequence: `global` isn't ambiently typed, so `global.d.ts` declares `var global: typeof globalThis`. If you need another global in a test, prefer a minimal declaration over adding @types/node.
- **`@expo-google-fonts/*` install with `--legacy-peer-deps`** (a `react-dom` peer range conflict; the packages work fine at runtime). Confirmed export names: `Fraunces_600SemiBold`, `Geist_400Regular`, `Geist_600SemiBold`, `GeistMono_500Medium`.
- **ts-rs export into `src/types/` uses `export_to_string()` + manual file write**, NOT `export_all_to`. The contract types' `#[ts(export_to = "../../../DesktopApp/src/types/")]` attribute path starts with `../`, which cancels any `export_all_to(dir)` join and silently lands files back in the desktop target. The crate test `export_contract_to_mobile_app` (`crates/abeon-remote-core/src/protocol.rs`) renders each type with `export_to_string()` and writes it to `../../MobileApp/src/types/` (resolved from the crate manifest dir, which is cargo's cwd for tests). Regenerate with `cargo test --manifest-path crates/abeon-remote-core/Cargo.toml`; afterwards verify `git status DesktopApp/src/types` is clean.

## Commands (all under Node 22)

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
npm run lint        # tsc --noEmit, expect exit 0
npm test            # jest (jest-expo/web)
npx jest <pattern>  # a single spec
npx expo start      # dev server (needs a device/emulator — not available in CI/headless)
```
Regenerate contract types (from repo root, needs cargo):
```bash
cargo test --manifest-path crates/abeon-remote-core/Cargo.toml
```

## EAS (build / push)

- `eas.json` defines `development` / `preview` / `production` build profiles (managed, `appVersionSource: remote`).
- The EAS **projectId** lives in `app.json` `extra.eas.projectId` (`cb3ebb61-…`). `src/lib/push.ts` reads it via `expo-constants` and passes it to `getExpoPushTokenAsync` — **required for push tokens on a real build** (the no-arg call fails on device).
- Building/submitting needs an interactive `eas login` (run yourself: `! eas login`, then `! eas build --profile preview`). Push only works end-to-end on a real device build (Expo Go can't receive the production push reliably) with the CloudService `/v1/notify` reachable.

