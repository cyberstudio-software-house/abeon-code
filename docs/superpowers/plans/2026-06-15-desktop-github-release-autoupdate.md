# Desktop GitHub Release + Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wpiąć repo GitHub jako główne, automatycznie wydawać podpisane release'y desktopa po pushu na `main` (gdy wzrośnie wersja) i dać aplikacji samo-aktualizację z dialogiem po polsku.

**Architecture:** Jedno źródło wersji (`DesktopApp/package.json`) propagowane skryptem do `Cargo.toml` i `tauri.conf.json`. Workflow GitHub Actions wykrywa bump wersji, buduje na 3 platformach przez `tauri-apps/tauri-action`, podpisuje paczki i publikuje GitHub Release z `latest.json`. Aplikacja używa `tauri-plugin-updater` + `tauri-plugin-process`, sprawdza aktualizacje przy starcie i pokazuje `UpdateDialog`.

**Tech Stack:** Tauri 2, Rust, React 19 + TypeScript, Vitest + @testing-library/react, GitHub Actions, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`.

**Spec:** `docs/superpowers/specs/2026-06-15-desktop-github-release-autoupdate-design.md`

---

## File structure

| Plik | Rola | Akcja |
|------|------|-------|
| `DesktopApp/scripts/sync-version.mjs` | Propaguje `package.json.version` → `Cargo.toml` + `tauri.conf.json` | Create |
| `DesktopApp/scripts/sync-version.test.mjs` | Test skryptu sync | Create |
| `DesktopApp/package.json` | Wersja (źródło prawdy), `version` npm-lifecycle, deps JS | Modify |
| `DesktopApp/src-tauri/tauri.conf.json` | Wersja 0.1.2, `plugins.updater`, `createUpdaterArtifacts` | Modify |
| `DesktopApp/src-tauri/Cargo.toml` | `tauri-plugin-updater`, `tauri-plugin-process`, wersja | Modify |
| `DesktopApp/src-tauri/src/lib.rs` | Rejestracja pluginów | Modify |
| `DesktopApp/src-tauri/capabilities/default.json` | Uprawnienia updater/process | Modify |
| `DesktopApp/src/lib/updater.ts` | Typed wrapper nad plugin-updater/process | Create |
| `DesktopApp/src/lib/updater.test.ts` | Testy wrappera | Create |
| `DesktopApp/src/components/dialogs/UpdateDialog.tsx` | Dialog aktualizacji (PL) | Create |
| `DesktopApp/src/components/dialogs/UpdateDialog.test.tsx` | Testy dialogu | Create |
| `DesktopApp/src/components/layout/AppShell.tsx` | Sprawdzenie przy starcie + render dialogu | Modify |
| `.github/workflows/release.yml` | CI: detekcja bumpu + build/release matryca | Create |
| `.gitignore` | Ignorowanie kluczy podpisu | Modify |

Kroki operacyjne (klucze, sekrety, remote, push) są osobnymi taskami z dokładnymi komendami.

---

## Task 1: Wersjonowanie — jedno źródło prawdy

**Files:**
- Create: `DesktopApp/scripts/sync-version.mjs`
- Create: `DesktopApp/scripts/sync-version.test.mjs`
- Modify: `DesktopApp/src-tauri/tauri.conf.json` (`"version": "0.1.0"` → `"0.1.2"`)
- Modify: `DesktopApp/package.json` (dodać skrypty)

- [ ] **Step 1: Napisz test skryptu sync (failing)**

Create `DesktopApp/scripts/sync-version.test.mjs`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVersion } from './sync-version.mjs';

describe('syncVersion', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'syncver-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }, null, 2));
    writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ productName: 'X', version: '0.0.0' }, null, 2));
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.0.0"\nedition = "2021"\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('propagates package.json version into tauri.conf.json and Cargo.toml', () => {
    syncVersion({
      packageJson: join(dir, 'package.json'),
      tauriConf: join(dir, 'tauri.conf.json'),
      cargoToml: join(dir, 'Cargo.toml'),
    });
    expect(JSON.parse(readFileSync(join(dir, 'tauri.conf.json'), 'utf8')).version).toBe('1.2.3');
    expect(readFileSync(join(dir, 'Cargo.toml'), 'utf8')).toContain('version = "1.2.3"');
  });

  it('only rewrites the [package] version, not other version keys', () => {
    writeFileSync(join(dir, 'Cargo.toml'),
      '[package]\nname = "x"\nversion = "0.0.0"\n\n[dependencies]\nfoo = { version = "9.9.9" }\n');
    syncVersion({
      packageJson: join(dir, 'package.json'),
      tauriConf: join(dir, 'tauri.conf.json'),
      cargoToml: join(dir, 'Cargo.toml'),
    });
    const cargo = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    expect(cargo).toContain('version = "1.2.3"');
    expect(cargo).toContain('foo = { version = "9.9.9" }');
  });
});
```

- [ ] **Step 2: Uruchom test — ma się wywalić**

Run: `cd DesktopApp && npx vitest run scripts/sync-version.test.mjs`
Expected: FAIL — `Cannot find module './sync-version.mjs'`.

- [ ] **Step 3: Zaimplementuj skrypt**

Create `DesktopApp/scripts/sync-version.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function syncVersion({ packageJson, tauriConf, cargoToml }) {
  const version = JSON.parse(readFileSync(packageJson, 'utf8')).version;
  if (!version) throw new Error('package.json has no version');

  const conf = JSON.parse(readFileSync(tauriConf, 'utf8'));
  conf.version = version;
  writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + '\n');

  const cargo = readFileSync(cargoToml, 'utf8');
  const patched = cargo.replace(
    /(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  if (patched === cargo) throw new Error('Could not find [package] version in Cargo.toml');
  writeFileSync(cargoToml, patched);
  return version;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  const root = join(dirname(thisFile), '..');
  const v = syncVersion({
    packageJson: join(root, 'package.json'),
    tauriConf: join(root, 'src-tauri', 'tauri.conf.json'),
    cargoToml: join(root, 'src-tauri', 'Cargo.toml'),
  });
  console.log(`Synced version → ${v}`);
}
```

- [ ] **Step 4: Uruchom test — ma przejść**

Run: `cd DesktopApp && npx vitest run scripts/sync-version.test.mjs`
Expected: PASS (2 testy).

- [ ] **Step 5: Napraw rozjazd wersji i podłącz npm-lifecycle**

Run once to fix `tauri.conf.json` (0.1.0 → 0.1.2):
`cd DesktopApp && node scripts/sync-version.mjs`
Expected output: `Synced version → 0.1.2`

In `DesktopApp/package.json` add to the `scripts` block:

```json
    "sync-version": "node scripts/sync-version.mjs",
    "version": "node scripts/sync-version.mjs && git add src-tauri/tauri.conf.json src-tauri/Cargo.toml"
```

- [ ] **Step 6: Weryfikacja i commit**

Run: `cd DesktopApp && git diff --stat src-tauri/tauri.conf.json`
Expected: pokazuje zmianę wersji na `0.1.2`.

```bash
git add DesktopApp/scripts/sync-version.mjs DesktopApp/scripts/sync-version.test.mjs \
        DesktopApp/package.json DesktopApp/src-tauri/tauri.conf.json
git commit -m "build(desktop): single-source version sync across package.json/Cargo/tauri.conf"
```

---

## Task 2: Plugin updatera w backendzie (Rust)

**Files:**
- Modify: `DesktopApp/src-tauri/Cargo.toml`
- Modify: `DesktopApp/src-tauri/src/lib.rs:30-33`
- Modify: `DesktopApp/src-tauri/capabilities/default.json`

- [ ] **Step 1: Dodaj zależności Rust**

In `DesktopApp/src-tauri/Cargo.toml`, w sekcji `[dependencies]` dodaj (obok innych `tauri-plugin-*`):

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

- [ ] **Step 2: Zarejestruj pluginy w `lib.rs`**

In `DesktopApp/src-tauri/src/lib.rs`, zamień blok rejestracji (linie ~30-33):

```rust
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
```

na:

```rust
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 3: Dodaj uprawnienia w capabilities**

In `DesktopApp/src-tauri/capabilities/default.json`, w tablicy `permissions` dodaj na końcu:

```json
    "updater:default",
    "process:default"
```

(pamiętaj o przecinku po poprzednim wpisie `"core:window:allow-unminimize"`).

- [ ] **Step 4: Skompiluj backend**

Run: `cd DesktopApp/src-tauri && cargo build`
Expected: kompiluje się bez błędów (pierwszy build pobierze nowe crate'y).

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src-tauri/Cargo.toml DesktopApp/src-tauri/Cargo.lock \
        DesktopApp/src-tauri/src/lib.rs DesktopApp/src-tauri/capabilities/default.json
git commit -m "feat(desktop): register updater and process plugins"
```

---

## Task 3: Klucze podpisu + konfiguracja updatera w `tauri.conf.json`

**Files:**
- Modify: `.gitignore`
- Modify: `DesktopApp/src-tauri/tauri.conf.json`
- (operacyjne) generacja kluczy + GitHub Secrets

- [ ] **Step 1: Zabezpiecz `.gitignore` PRZED generacją klucza**

In `.gitignore` (root repo) dodaj:

```gitignore
# Tauri updater signing keys — NEVER commit
*.key
*.key.pub
```

Commit od razu, żeby nie było ryzyka zacommitowania klucza:

```bash
git add .gitignore
git commit -m "chore: gitignore tauri signing keys"
```

- [ ] **Step 2: Wygeneruj parę kluczy podpisu**

Run (interaktywnie poprosi o hasło — ustaw mocne i ZAPISZ je w menedżerze haseł):
`cd DesktopApp && npx tauri signer generate -w ~/.abeon-tauri-signing.key`

Expected: tworzy `~/.abeon-tauri-signing.key` (prywatny) i wypisuje klucz publiczny na stdout
(oraz `~/.abeon-tauri-signing.key.pub`). Skopiuj wartość klucza publicznego.

> **Backup (krytyczne):** prywatny klucz `~/.abeon-tauri-signing.key` + hasło zapisz poza repo.
> Ich utrata = brak możliwości wydania aktualizacji kompatybilnych z już zainstalowanymi wersjami.

- [ ] **Step 3: Wpisz klucz publiczny i config updatera do `tauri.conf.json`**

In `DesktopApp/src-tauri/tauri.conf.json`, w obiekcie `bundle` dodaj pole:

```json
    "createUpdaterArtifacts": true
```

oraz dodaj nową sekcję `plugins` na najwyższym poziomie configu (obok `app`, `bundle`):

```json
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/cyberstudio-software-house/abeon-code/releases/latest/download/latest.json"
      ],
      "pubkey": "WKLEJ_TU_KLUCZ_PUBLICZNY_ZE_STEP_2",
      "windows": {
        "installMode": "passive"
      }
    }
  }
```

- [ ] **Step 4: Ustaw GitHub Secrets (build CI)**

Run (podstaw rzeczywiste hasło z kroku 2):

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY \
  --repo cyberstudio-software-house/abeon-code < ~/.abeon-tauri-signing.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  --repo cyberstudio-software-house/abeon-code --body 'HASLO_Z_KROKU_2'
```

Verify: `gh secret list --repo cyberstudio-software-house/abeon-code`
Expected: lista zawiera oba sekrety.

- [ ] **Step 5: Sprawdź, że klucz NIE jest w drzewie repo**

Run: `git status --porcelain | grep -i '\.key' || echo "OK — brak plików klucza w repo"`
Expected: `OK — brak plików klucza w repo`.

- [ ] **Step 6: Commit konfiguracji**

```bash
git add DesktopApp/src-tauri/tauri.conf.json
git commit -m "feat(desktop): configure updater endpoint, pubkey and updater artifacts"
```

---

## Task 4: Frontend — typed wrapper `lib/updater.ts`

**Files:**
- Modify: `DesktopApp/package.json` (deps JS)
- Create: `DesktopApp/src/lib/updater.ts`
- Create: `DesktopApp/src/lib/updater.test.ts`

- [ ] **Step 1: Dodaj zależności JS**

Run: `cd DesktopApp && npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process`
Expected: dopisane do `dependencies` w `package.json`.

- [ ] **Step 2: Napisz test wrappera (failing)**

Create `DesktopApp/src/lib/updater.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const check = vi.fn();
const relaunch = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));

import { checkForUpdate } from './updater';

describe('checkForUpdate', () => {
  beforeEach(() => { check.mockReset(); relaunch.mockReset(); });

  it('returns null when no update is available', async () => {
    check.mockResolvedValue(null);
    expect(await checkForUpdate()).toBeNull();
  });

  it('returns null and swallows errors when check throws', async () => {
    check.mockRejectedValue(new Error('offline'));
    expect(await checkForUpdate()).toBeNull();
  });

  it('maps an available update to version + notes', async () => {
    check.mockResolvedValue({ version: '0.2.0', body: 'Nowości', downloadAndInstall: vi.fn() });
    const update = await checkForUpdate();
    expect(update?.version).toBe('0.2.0');
    expect(update?.notes).toBe('Nowości');
  });

  it('forwards download progress to the callback', async () => {
    const downloadAndInstall = vi.fn(async (onEvent: (e: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 40 } });
      onEvent({ event: 'Progress', data: { chunkLength: 60 } });
      onEvent({ event: 'Finished' });
    });
    check.mockResolvedValue({ version: '0.2.0', body: '', downloadAndInstall });
    const update = await checkForUpdate();
    const seen: Array<[number, number | null]> = [];
    await update!.downloadAndInstall((d, t) => seen.push([d, t]));
    expect(seen).toEqual([[40, 100], [100, 100]]);
  });
});
```

- [ ] **Step 3: Uruchom test — ma się wywalić**

Run: `cd DesktopApp && npx vitest run src/lib/updater.test.ts`
Expected: FAIL — `Cannot find module './updater'`.

- [ ] **Step 4: Zaimplementuj wrapper**

Create `DesktopApp/src/lib/updater.ts`:

```ts
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type AvailableUpdate = {
  version: string;
  notes: string;
  downloadAndInstall: (onProgress?: (downloaded: number, total: number | null) => void) => Promise<void>;
  relaunch: () => Promise<void>;
};

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  let update: Update | null;
  try {
    update = await check();
  } catch (err) {
    console.error('Update check failed', err);
    return null;
  }
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body ?? '',
    downloadAndInstall: async (onProgress) => {
      let downloaded = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          onProgress?.(downloaded, total);
        }
      });
    },
    relaunch,
  };
}
```

- [ ] **Step 5: Uruchom test — ma przejść**

Run: `cd DesktopApp && npx vitest run src/lib/updater.test.ts`
Expected: PASS (4 testy).

- [ ] **Step 6: Commit**

```bash
git add DesktopApp/package.json DesktopApp/package-lock.json \
        DesktopApp/src/lib/updater.ts DesktopApp/src/lib/updater.test.ts
git commit -m "feat(desktop): add updater wrapper over plugin-updater/process"
```

---

## Task 5: Komponent `UpdateDialog`

**Files:**
- Create: `DesktopApp/src/components/dialogs/UpdateDialog.tsx`
- Create: `DesktopApp/src/components/dialogs/UpdateDialog.test.tsx`

Wzorzec wizualny i klawiatura jak w `ConfirmDialog.tsx`. Dialog jest prezentacyjny — pobieranie i restart orkiestruje `AppShell` (Task 6).

- [ ] **Step 1: Napisz test komponentu (failing)**

Create `DesktopApp/src/components/dialogs/UpdateDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { UpdateDialog } from './UpdateDialog';

afterEach(cleanup);

describe('UpdateDialog', () => {
  const base = { version: '0.2.0', notes: 'Lista zmian', busy: false, progress: null,
    onUpdate: () => {}, onLater: () => {} };

  it('shows the new version and notes', () => {
    render(<UpdateDialog {...base} />);
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText('Lista zmian')).toBeInTheDocument();
  });

  it('calls onUpdate when the update button is clicked', () => {
    const onUpdate = vi.fn();
    render(<UpdateDialog {...base} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zaktualizuj' }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('disables buttons and shows percent while busy', () => {
    render(<UpdateDialog {...base} busy progress={0.5} />);
    expect(screen.getByRole('button', { name: /Pobieranie/ })).toBeDisabled();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('calls onLater when the later button is clicked', () => {
    const onLater = vi.fn();
    render(<UpdateDialog {...base} onLater={onLater} />);
    fireEvent.click(screen.getByRole('button', { name: 'Później' }));
    expect(onLater).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Uruchom test — ma się wywalić**

Run: `cd DesktopApp && npx vitest run src/components/dialogs/UpdateDialog.test.tsx`
Expected: FAIL — `Cannot find module './UpdateDialog'`.

- [ ] **Step 3: Zaimplementuj komponent**

Create `DesktopApp/src/components/dialogs/UpdateDialog.tsx`:

```tsx
type Props = {
  version: string;
  notes: string;
  busy: boolean;
  progress: number | null;
  onUpdate: () => void;
  onLater: () => void;
};

export function UpdateDialog({ version, notes, busy, progress, onUpdate, onLater }: Props) {
  const percent = progress != null ? Math.round(progress * 100) : null;
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border p-5 w-[420px]">
        <h2 className="text-[14px] font-semibold mb-2">Dostępna aktualizacja</h2>
        <p className="text-[13px] text-fg-secondary mb-2">
          Nowa wersja <span className="text-fg font-medium">{version}</span> jest gotowa do instalacji.
        </p>
        {notes && (
          <pre className="text-[12px] text-fg-secondary mb-4 max-h-40 overflow-auto whitespace-pre-wrap">{notes}</pre>
        )}
        {busy && percent != null && (
          <div className="mb-4">
            <div className="h-1 bg-border">
              <div className="h-1 bg-accent" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-[11px] text-fg-secondary mt-1">{percent}%</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onLater} disabled={busy}
            className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg disabled:opacity-50">
            Później
          </button>
          <button onClick={onUpdate} disabled={busy}
            className="px-3 py-1.5 bg-accent text-white text-[12px] disabled:opacity-50">
            {busy ? 'Pobieranie…' : 'Zaktualizuj'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

> Uwaga: jeśli klasa `bg-accent` nie istnieje w `tailwind.config.ts`, użyj koloru spójnego z resztą
> (sprawdź `ConfirmDialog` używa `bg-danger`). Zweryfikuj w Step 4 wizualnie/lintem; w razie braku
> podmień `bg-accent`/`text-accent` na istniejący token.

- [ ] **Step 4: Uruchom test + lint — mają przejść**

Run: `cd DesktopApp && npx vitest run src/components/dialogs/UpdateDialog.test.tsx && npm run lint`
Expected: testy PASS (4), lint zero błędów.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/components/dialogs/UpdateDialog.tsx \
        DesktopApp/src/components/dialogs/UpdateDialog.test.tsx
git commit -m "feat(desktop): add UpdateDialog component"
```

---

## Task 6: Wpięcie sprawdzania aktualizacji w `AppShell`

**Files:**
- Modify: `DesktopApp/src/components/layout/AppShell.tsx`

- [ ] **Step 1: Dodaj importy**

In `DesktopApp/src/components/layout/AppShell.tsx`, do bloku importów dodaj:

```tsx
import { useState } from 'react';
import { checkForUpdate, type AvailableUpdate } from '../../lib/updater';
import { UpdateDialog } from '../dialogs/UpdateDialog';
```

(uzupełnij istniejący `import { useCallback, useEffect } from 'react';` o `useState`, lub dodaj osobno).

- [ ] **Step 2: Dodaj stan i efekt sprawdzania przy starcie**

W ciele `AppShell`, obok pozostałych `useState`/`useEffect` (po istniejących hookach, przed `return`):

```tsx
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((u) => { if (!cancelled && u) setUpdate(u); });
    return () => { cancelled = true; };
  }, []);

  const runUpdate = useCallback(async () => {
    if (!update) return;
    setUpdateBusy(true);
    try {
      await update.downloadAndInstall((downloaded, total) => {
        setUpdateProgress(total ? downloaded / total : null);
      });
      await update.relaunch();
    } catch (err) {
      console.error('Update install failed', err);
      setUpdateBusy(false);
      setUpdate(null);
    }
  }, [update]);
```

- [ ] **Step 3: Wyrenderuj dialog**

W `return (...)`, tuż przed zamykającym `</div>` po `<TabSwitcher />` (linia ~187), dodaj:

```tsx
      <TabSwitcher />
      {update && (
        <UpdateDialog
          version={update.version}
          notes={update.notes}
          busy={updateBusy}
          progress={updateProgress}
          onUpdate={() => void runUpdate()}
          onLater={() => setUpdate(null)}
        />
      )}
```

- [ ] **Step 4: Lint + testy frontu**

Run: `cd DesktopApp && npm run lint && npm test`
Expected: lint zero błędów, wszystkie testy PASS.

- [ ] **Step 5: Commit**

```bash
git add DesktopApp/src/components/layout/AppShell.tsx
git commit -m "feat(desktop): check for updates on startup and show UpdateDialog"
```

---

## Task 7: Workflow GitHub Actions — release po bumpie wersji

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Utwórz workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release Desktop

on:
  push:
    branches: [main]
    paths:
      - 'DesktopApp/**'
      - '.github/workflows/release.yml'

permissions:
  contents: write

jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      should_release: ${{ steps.check.outputs.should_release }}
      version: ${{ steps.check.outputs.version }}
    steps:
      - uses: actions/checkout@v4
      - id: check
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          version="$(node -p "require('./DesktopApp/package.json').version")"
          echo "version=$version" >> "$GITHUB_OUTPUT"
          last="$(gh release view --json tagName -q .tagName 2>/dev/null || echo '')"
          echo "last release tag: '$last', package version: 'v$version'"
          if [ "$last" = "v$version" ]; then
            echo "should_release=false" >> "$GITHUB_OUTPUT"
          else
            echo "should_release=true" >> "$GITHUB_OUTPUT"
          fi

  release:
    needs: detect
    if: needs.detect.outputs.should_release == 'true'
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: ubuntu-22.04
            args: ''
          - platform: windows-latest
            args: ''
          - platform: macos-latest
            args: '--target universal-apple-darwin'
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - name: Install Linux dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: DesktopApp/package-lock.json

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - uses: swatinem/rust-cache@v2
        with:
          workspaces: DesktopApp/src-tauri -> target

      - name: Install frontend dependencies
        run: npm ci
        working-directory: DesktopApp

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          projectPath: DesktopApp
          tagName: v${{ needs.detect.outputs.version }}
          releaseName: 'AbeonCode v${{ needs.detect.outputs.version }}'
          releaseBody: 'Zobacz listę zmian poniżej.'
          releaseDraft: false
          prerelease: false
          includeUpdaterJson: true
          args: ${{ matrix.args }}
```

- [ ] **Step 2: Walidacja składni YAML lokalnie**

Run: `node -e "require('js-yaml')" 2>/dev/null && npx --yes js-yaml .github/workflows/release.yml > /dev/null && echo "YAML OK" || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: release desktop on main when version bumps"
```

---

## Task 8: Pre-flight bezpieczeństwa, remote i pierwszy release (operacyjne)

> Te kroki zmieniają stan zewnętrzny (push, upublicznienie repo). Wykonywać świadomie,
> potwierdzając z użytkownikiem. NIE pushować bez wyraźnej zgody (zasada repo).

- [ ] **Step 1: Skan historii gita pod kątem sekretów (GATE — blokuje upublicznienie)**

Run: `gitleaks detect --source . --redact -v` (lub `docker run --rm -v "$PWD:/r" zricethezav/gitleaks:latest detect --source /r --redact`).
Jeśli `gitleaks` niedostępny, fallback ręczny:
`git log -p --all | grep -nEi 'secret|password|token|api[_-]?key|BEGIN .*PRIVATE KEY|hmac' | head -40`
Expected: brak realnych sekretów. **Jeśli coś znajdziesz — STOP**, repo NIE może iść na publiczne
bez czyszczenia historii (`git filter-repo`) i rotacji sekretów. Zgłoś użytkownikowi.

- [ ] **Step 2: Przepnij `origin` na GitHub**

```bash
git remote rename origin bitbucket
git remote add origin git@github.com:cyberstudio-software-house/abeon-code.git
git remote -v
```
Expected: `origin` → GitHub, `bitbucket` → stary URL.

- [ ] **Step 3: (za zgodą użytkownika) Push gałęzi i merge do main**

Najpierw push gałęzi roboczej i merge przez PR LUB bezpośrednio main — zależnie od preferencji.
Po wejściu na `main`, workflow nie zrobi release dopóki repo prywatne nie zostanie upublicznione
(updater endpoint by nie działał) — patrz Step 4.

```bash
git push -u origin HEAD
```

- [ ] **Step 4: (za zgodą + po przejściu GATE ze Step 1) Upublicznij repo**

```bash
gh repo edit cyberstudio-software-house/abeon-code --visibility public --accept-visibility-change-consequences
```
Verify: `gh repo view cyberstudio-software-house/abeon-code --json visibility`
Expected: `{"visibility":"PUBLIC"}`.

- [ ] **Step 5: Wyzwól pierwszy release przez bump wersji**

```bash
cd DesktopApp && npm version patch -m "chore(release): %s"
git push origin main
```
Expected: workflow `Release Desktop` startuje, job `detect` → `should_release=true`,
job `release` buduje 3 platformy i publikuje GitHub Release `v0.1.3` z `latest.json`.
Sprawdź: zakładka Actions oraz `gh release view --repo cyberstudio-software-house/abeon-code`.

- [ ] **Step 6: Weryfikacja auto-update end-to-end**

Zainstaluj wydaną `0.1.2` (lub wcześniejszą), potem opublikuj `0.1.3` i uruchom aplikację.
Expected: po starcie pojawia się `UpdateDialog` z wersją `0.1.3`; „Zaktualizuj" pobiera,
instaluje i restartuje aplikację na nową wersję.

---

## Self-review notes

- **Spec coverage:** wersjonowanie (T1), plugin Rust (T2), klucze+config updatera (T3),
  wrapper JS (T4), dialog (T5), wpięcie startowe (T6), workflow CI z detekcją bumpu (T7),
  remote+publiczne repo+pre-flight sekretów+pierwszy release+weryfikacja E2E (T8). Wszystkie
  sekcje specu pokryte.
- **macOS bez notaryzacji / Windows bez Authenticode:** zgodnie ze specem poza zakresem; build
  i auto-update działają, ostrzeżenia OS zostają.
- **Endpoint updatera** zależy od publicznego repo (T8 Step 4) — to twardy warunek działania
  aktualizacji u użytkowników; przed nim release i tak by się zbudował, ale aplikacje nie
  pobrałyby `latest.json`.
```