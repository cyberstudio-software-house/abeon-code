# AbeonCode

Desktopowa aplikacja (Tauri 2) do zarządzania wieloma sesjami Claude Code: lista projektów, podgląd historii sesji, wbudowany terminal do kontynuacji, panel akcji i status git.

## Wymagania

- Linux lub macOS
- Node.js 20+
- Rust toolchain (stable)
- `claude` CLI w PATH

## Rozwój

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Testy

```bash
npm test              # frontend (vitest)
npm run test:rust     # backend (cargo test)
```

## Architektura

Patrz `docs/superpowers/specs/2026-05-21-abeoncode-design.md` i `docs/superpowers/plans/2026-05-21-abeoncode-implementation.md`.
