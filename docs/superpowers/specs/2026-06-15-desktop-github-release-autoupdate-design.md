# DesktopApp — GitHub release + auto-update (design)

Status: approved (2026-06-15)
Scope: `DesktopApp/` (Tauri 2) + repo-level Git/CI configuration

## Goal

Wpięcie repozytorium GitHub (`git@github.com:cyberstudio-software-house/abeon-code.git`)
jako głównego zdalnego repo oraz automatyczne wydawanie release'ów desktopa i samo-aktualizacja
aplikacji u użytkowników. Release powstaje po pushu na `main` — ale tylko gdy wzrosła wersja.

## Decisions (from brainstorming)

- **Platformy**: Linux + Windows + macOS.
- **Wyzwalanie release**: gdy wersja w `package.json` jest wyższa niż tag ostatniego release'u.
  Zwykłe commity (fix/refactor bez bumpu) nie tworzą release'u.
- **Repo Git**: `origin` → GitHub; Bitbucket zostaje jako zdalne `bitbucket`.
- **Widoczność repo**: `abeon-code` staje się **publiczne** (decyzja użytkownika 2026-06-15).
  Dzięki temu endpoint updatera działa bez tokena (oryginalna architektura 1:1).
  **Warunek bezpieczeństwa (pre-flight, blokujący)**: przed upublicznieniem przeskanować
  CAŁĄ historię gita pod kątem zacommitowanych sekretów (np. `gitleaks detect`/`trufflehog`,
  ręczny przegląd `git log -p` po wzorcach kluczy/tokenów/.env). Upublicznienie ujawnia
  historię nieodwracalnie — usunięty później sekret nadal w niej jest.
- **UX aktualizacji**: po starcie ciche sprawdzenie; jeśli jest nowa wersja — dialog po polsku
  (styl `ConfirmDialog`) z changelogiem i przyciskiem „Zaktualizuj"; pobranie+instalacja+restart za zgodą.
- **macOS**: bez notaryzacji Apple na teraz (działa, ostrzeżenie Gatekeepera). Notaryzacja later.
- **Changelog w dialogu**: body GitHub Release (wypełniane z commitów).

## Architecture

```
push na main (ze zmianą wersji w package.json)
        │
        ▼
GitHub Actions
  job: detect-version  → porównuje package.json vs tag ostatniego release
        │ (wersja wyższa)
        ▼
  job: release (matryca: ubuntu / windows / macos)
        tauri-apps/tauri-action: build frontend + build Tauri + podpis + bundle
        │
        ▼
GitHub Release (tag vX.Y.Z, draft=false)
   ├─ artefakty: AppImage (Linux), NSIS .exe (Windows), .dmg/.app (macOS)
   └─ latest.json  ← manifest updatera (wersja + URL per platforma + sygnatura)
        │
        ▼
Aplikacja: tauri-plugin-updater sprawdza latest.json przy starcie
   └─► UpdateDialog (PL) → download → install → relaunch (tauri-plugin-process)
```

Cztery niezależne elementy:
- **(a)** plugin updatera w aplikacji (Rust + JS wrapper + dialog),
- **(b)** klucze podpisu (public w repo, private w GitHub Secrets),
- **(c)** workflow GitHub Actions (`.github/workflows/release.yml`),
- **(d)** wersjonowanie jako wyzwalacz + sync trzech plików.

## Components

### (d) Wersjonowanie — jedno źródło prawdy

Obecny rozjazd: `package.json` 0.1.2, `Cargo.toml` 0.1.2, `tauri.conf.json` 0.1.0.

- **Źródło prawdy**: `DesktopApp/package.json` → `version`.
- **`DesktopApp/scripts/sync-version.mjs`**: czyta `package.json.version` i zapisuje tę samą
  wartość do `src-tauri/Cargo.toml` (`[package] version`) oraz `src-tauri/tauri.conf.json` (`version`).
- Podpięcie pod npm lifecycle (`"version": "node scripts/sync-version.mjs && git add ..."` w `package.json`),
  tak że `npm version patch|minor|major` podbija wszystkie trzy pliki w jednym commicie.
- **Pierwszy krok porządkowy**: zsynchronizować obecne pliki do `0.1.2` (naprawić `tauri.conf.json`).

### (c) GitHub Actions — `.github/workflows/release.yml`

- Trigger: `push` na `main` (ścieżki: `DesktopApp/**`, sam workflow).
- Job `detect`:
  - czyta `DesktopApp/package.json` → `version`,
  - pobiera najnowszy release tag przez `gh release view` / API,
  - ustawia output `should_release` = (version != last_tag) i `version`.
- Job `release` (`needs: detect`, `if: should_release == 'true'`):
  - `strategy.matrix`: `ubuntu-22.04`, `windows-latest`, `macos-latest`
    (macos: target uniwersalny `aarch64-apple-darwin` + `x86_64-apple-darwin`).
  - kroki: checkout, setup-node, rust toolchain (+ targets), zależności systemowe Linux
    (webkit2gtk, libappindicator, librsvg, patchelf), `npm ci` w `DesktopApp`,
  - `tauri-apps/tauri-action@v0`:
    - `projectPath: DesktopApp`,
    - `tagName: v__VERSION__`, `releaseName`, `releaseBody` (z commitów / autogenerate),
    - `includeUpdaterJson: true` (generuje/aktualizuje `latest.json`),
    - env: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `GITHUB_TOKEN`.
- Uprawnienia workflow: `contents: write` (tworzenie release i tagów).

### (b) Klucze podpisu

- `tauri signer generate` (z hasłem) → para kluczy.
- **public key** → `tauri.conf.json` → `plugins.updater.pubkey`.
- **private key + hasło** → GitHub Secrets: `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (ustawiane przez `gh secret set`).
- **Backup**: prywatny klucz zapisany lokalnie poza repo; ostrzeżenie dla użytkownika —
  utrata klucza = brak możliwości podpisania aktualizacji kompatybilnych z wydanymi wersjami.
- `.gitignore`: upewnić się, że pliki klucza (`*.key`, `*.key.pub`) nie trafią do repo.

### (a) Zmiany w aplikacji

Rust (`src-tauri/`):
- `Cargo.toml`: `tauri-plugin-updater`, `tauri-plugin-process`.
- `lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())` + `.plugin(tauri_plugin_process::init())`.
- Capabilities: dodać uprawnienia `updater:default`, `process:allow-restart`.

`tauri.conf.json`:
- `plugins.updater`:
  - `endpoints`: `["https://github.com/cyberstudio-software-house/abeon-code/releases/latest/download/latest.json"]`,
  - `pubkey`: <public key>,
  - `windows.installMode`: `passive` (domyślny dla NSIS).
- `bundle.createUpdaterArtifacts: true`.

Frontend (`src/`):
- **`src/lib/updater.ts`** — wrapper nad `@tauri-apps/plugin-updater` / `plugin-process`:
  `checkForUpdate()` → zwraca `{ version, notes, downloadAndInstall, relaunch }` lub `null`.
  (Konwencja repo: integracje opakowane w `lib/`, nie wołane luzem z komponentów.)
- **`src/components/dialogs/UpdateDialog.tsx`** — w stylu `ConfirmDialog`, teksty PL:
  tytuł „Dostępna aktualizacja", wersja, changelog, przyciski „Zaktualizuj" / „Później".
  Stan postępu pobierania.
- Wywołanie sprawdzenia przy starcie w `AppShell.tsx` (ciche; dialog tylko gdy jest update).
- `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` w `package.json`.

### Repo Git

- `git remote rename origin bitbucket`
- `git remote add origin git@github.com:cyberstudio-software-house/abeon-code.git`
- Push wykonujemy dopiero po wyraźnej zgodzie użytkownika (zasada repo).

## Error handling

- Brak sieci / niedostępny endpoint przy sprawdzaniu update → cichy brak dialogu, log do konsoli;
  nie blokuje startu aplikacji.
- Błąd weryfikacji podpisu → updater odrzuca paczkę (zachowanie pluginu); brak instalacji.
- `detect` job: gdy brak jakiegokolwiek release (pierwszy raz) → `should_release = true`.
- Build per-platforma jest niezależny w matrycy; tauri-action dołącza artefakt do wspólnego release.

## Testing / verification

- Po zmianach w kodzie: `npm run lint`, `npm test`, `npm run test:rust` (w `DesktopApp`).
- `sync-version.mjs`: ręczny sprawdzian, że `npm version patch` podbija 3 pliki spójnie.
- Workflow Actions: zweryfikowany realnym pushem na GitHub (świadoma decyzja użytkownika).
- Pełny cykl auto-update: wydać `0.1.3`, zaktualizować z zainstalowanej `0.1.2`.

## Out of scope (na teraz)

- Notaryzacja/podpis Apple Developer (macOS Gatekeeper) — osobny, płatny temat.
- Podpis kodu Windows (Authenticode) — SmartScreen ostrzeżenie zostaje.
- Kanały beta/stable, rollback, delta-updates.
```