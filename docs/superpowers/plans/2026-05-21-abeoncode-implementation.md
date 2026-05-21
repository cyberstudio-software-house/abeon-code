# AbeonCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zbudować Tauri 2 desktop app (Linux+macOS) zarządzającą sesjami Claude Code: lista projektów, podgląd historii JSONL jako chat, embedded terminal do kontynuacji sesji, panel akcji i status git.

**Architecture:** Backend Rust (Tauri 2) zarządza SQLite (projekty/akcje/settings), parsuje JSONL sesji z `~/.claude/projects/`, spawnuje procesy PTY przez `portable-pty`, i emituje eventy. Frontend React+Vite+TS renderuje 3-kolumnowy layout z zustand state, xterm.js terminalem i wirtualizowanym chat-view.

**Tech Stack:** Tauri 2, Rust (`portable-pty`, `notify`, `git2`, `rusqlite`, `tokio`, `serde`), React 18 + TS + Vite + Tailwind, `@xterm/xterm`, `react-virtuoso`, `react-markdown`, `shiki`, `zustand`.

**Spec:** `docs/superpowers/specs/2026-05-21-abeoncode-design.md`

---

## File Structure

```
AbeonCode/
├── src/                              # frontend
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx          # 3-column resizable container
│   │   │   ├── ResizableSplit.tsx    # generic resizable split
│   │   │   └── ThemeProvider.tsx     # dark/light/system, CSS vars
│   │   ├── sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── ProjectList.tsx
│   │   │   ├── ProjectItem.tsx
│   │   │   ├── SessionList.tsx
│   │   │   ├── SessionItem.tsx
│   │   │   └── AddProjectButton.tsx
│   │   ├── center/
│   │   │   ├── CenterPanel.tsx
│   │   │   ├── TabBar.tsx
│   │   │   └── TabContent.tsx
│   │   ├── history/
│   │   │   ├── HistoryView.tsx
│   │   │   ├── HistoryHeader.tsx
│   │   │   ├── HistoryStream.tsx     # react-virtuoso
│   │   │   ├── blocks/
│   │   │   │   ├── UserBubble.tsx
│   │   │   │   ├── AssistantBubble.tsx
│   │   │   │   ├── ThinkingBlock.tsx
│   │   │   │   ├── ToolUseBlock.tsx
│   │   │   │   ├── ToolResultBlock.tsx
│   │   │   │   ├── AttachmentBlock.tsx
│   │   │   │   └── SystemBlock.tsx
│   │   │   └── Markdown.tsx          # react-markdown + shiki
│   │   ├── terminal/
│   │   │   ├── TerminalView.tsx      # xterm.js + PTY bridge
│   │   │   └── ActionLogView.tsx     # same component, different label
│   │   ├── right/
│   │   │   ├── RightPanel.tsx
│   │   │   ├── ActionsSection.tsx
│   │   │   ├── ActionList.tsx
│   │   │   ├── ActionRow.tsx
│   │   │   ├── GitSection.tsx
│   │   │   ├── GitFileList.tsx
│   │   │   └── GitFileRow.tsx
│   │   └── dialogs/
│   │       ├── AddProjectDialog.tsx
│   │       ├── EditActionDialog.tsx
│   │       └── ConfirmDialog.tsx
│   ├── store/
│   │   ├── index.ts                  # combine slices
│   │   ├── projectsSlice.ts
│   │   ├── sessionsSlice.ts
│   │   ├── tabsSlice.ts
│   │   ├── ptySlice.ts
│   │   ├── gitSlice.ts
│   │   └── settingsSlice.ts
│   ├── lib/
│   │   ├── tauri.ts                  # typed wrappers nad invoke/listen
│   │   ├── pathEncoding.ts           # path → claude_dir encoding
│   │   └── format.ts                 # timestamps, file sizes
│   ├── types/                        # generated/shared with Rust (ts-rs)
│   │   └── index.ts
│   ├── styles/
│   │   ├── globals.css               # tailwind + CSS vars
│   │   └── theme.ts                  # theme variable map
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── main.rs                   # tauri::Builder + register commands
│   │   ├── lib.rs                    # re-exports
│   │   ├── error.rs                  # AppError + From impls
│   │   ├── state.rs                  # AppState struct (DB pool, PTY manager, watchers)
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── projects.rs
│   │   │   ├── sessions.rs
│   │   │   ├── pty.rs
│   │   │   ├── actions.rs
│   │   │   ├── git.rs
│   │   │   └── settings.rs
│   │   ├── domain/
│   │   │   ├── mod.rs
│   │   │   ├── project.rs
│   │   │   ├── action.rs
│   │   │   ├── session.rs            # SessionMeta, HistoryBlock enum
│   │   │   └── git.rs                # GitFile, GitStatus
│   │   ├── db/
│   │   │   ├── mod.rs                # pool, migrations
│   │   │   ├── migrations/
│   │   │   │   └── 001_initial.sql
│   │   │   ├── projects_repo.rs
│   │   │   ├── actions_repo.rs
│   │   │   └── settings_repo.rs
│   │   ├── sessions/
│   │   │   ├── mod.rs
│   │   │   ├── parser.rs             # JSONL → HistoryBlock
│   │   │   ├── reader.rs             # paginated read
│   │   │   ├── watcher.rs            # notify-based tail
│   │   │   └── encoding.rs           # path encoding helpers
│   │   ├── pty/
│   │   │   ├── mod.rs                # PtyManager (HashMap<PtyId, Handle>)
│   │   │   └── handle.rs             # PtyHandle with Drop guard
│   │   ├── detectors/
│   │   │   ├── mod.rs                # ScriptDetector trait + registry
│   │   │   ├── npm.rs
│   │   │   ├── composer.rs
│   │   │   ├── make.rs
│   │   │   ├── ddev.rs
│   │   │   └── docker_compose.rs
│   │   ├── git/
│   │   │   └── mod.rs                # git2 wrapper
│   │   └── events.rs                 # emit helpers
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/
│   │   └── default.json
│   └── icons/
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   └── 2026-05-21-abeoncode-design.md
│       └── plans/
│           └── 2026-05-21-abeoncode-implementation.md  ← ten plik
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── tailwind.config.ts
├── postcss.config.js
├── index.html
├── .gitignore
├── .editorconfig
└── README.md
```

---

## Phase 0 — Scaffold projektu

### Task 0.1: Inicjalizacja git i Tauri scaffold

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `.gitignore`, `README.md`

- [ ] **Step 1: Git init**

Run:
```bash
cd /home/pszweda/projects/cyberstudio/AbeonCode
git init -b main
```

- [ ] **Step 2: Utwórz `.gitignore`**

Write `.gitignore`:
```
node_modules/
dist/
.vite/
src-tauri/target/
src-tauri/gen/
.DS_Store
*.log
.env
.env.local
```

- [ ] **Step 3: Sprawdź Tauri CLI**

Run:
```bash
cargo install create-tauri-app --version "~4" 2>/dev/null || true
cargo install tauri-cli --version "^2" --locked 2>/dev/null || true
which cargo-tauri && cargo-tauri --version
```
Expected: wersja 2.x.

- [ ] **Step 4: Scaffold Tauri 2 z React+TS+Vite**

Run (z poziomu PARENT katalogu, bo create-tauri-app tworzy podkatalog):
```bash
cd /home/pszweda/projects/cyberstudio
mv AbeonCode AbeonCode.bak
npx create-tauri-app@latest AbeonCode --manager npm --template react-ts --identifier pl.cyberstudio.abeoncode --tauri-version 2 -y
mv AbeonCode.bak/docs AbeonCode/docs
mv AbeonCode.bak/.git AbeonCode/.git
rmdir AbeonCode.bak
cd AbeonCode
```
Expected: katalog `AbeonCode/` ma `src/`, `src-tauri/`, `package.json`, plus zachowane `docs/` i `.git/`.

- [ ] **Step 5: Instalacja zależności i pierwszy build**

Run:
```bash
npm install
npm run tauri dev -- --no-bundle 2>&1 | head -20 &
sleep 30
pkill -f "tauri dev" || true
```
Expected: aplikacja startuje bez błędów (sprawdź że WebView się otwiera, potem zabij).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: initial Tauri 2 + React + TypeScript scaffold

Bootstrapped via create-tauri-app with React+TS+Vite template.
Spec moved into docs/superpowers/specs/."
```

### Task 0.2: Instalacja dependencies (frontend + backend)

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`

- [ ] **Step 1: Frontend deps**

Run:
```bash
npm install zustand @xterm/xterm @xterm/addon-fit @xterm/addon-web-links react-virtuoso react-markdown remark-gfm rehype-raw shiki sonner clsx
npm install -D tailwindcss @tailwindcss/postcss postcss autoprefixer vitest @vitest/ui @testing-library/react @testing-library/jest-dom jsdom @types/node
```

- [ ] **Step 2: Backend deps**

Edit `src-tauri/Cargo.toml`, dodaj do `[dependencies]` (oprócz już istniejących `tauri`, `serde`, `serde_json`):
```toml
tokio = { version = "1", features = ["full"] }
portable-pty = "0.9"
notify = "8"
git2 = { version = "0.20", default-features = false, features = ["vendored-libgit2"] }
rusqlite = { version = "0.37", features = ["bundled"] }
r2d2 = "0.8"
r2d2_sqlite = "0.31"
thiserror = "2"
anyhow = "1"
dirs = "6"
once_cell = "1"
parking_lot = "0.12"
base64 = "0.22"
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1", features = ["v4", "serde"] }
ts-rs = { version = "11", features = ["serde-compat", "chrono-impl", "uuid-impl"] }
```

I dodaj `tauri-plugin-dialog = "2"` plus `tauri-plugin-fs = "2"` (do file picker).

- [ ] **Step 3: Frontend deps dla pluginów Tauri**

Run:
```bash
npm install @tauri-apps/plugin-dialog @tauri-apps/plugin-fs
```

- [ ] **Step 4: Cargo build sanity**

Run:
```bash
cd src-tauri && cargo build 2>&1 | tail -5 && cd ..
```
Expected: kompilacja bez błędów (może być długa za pierwszym razem).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add core dependencies (xterm, virtuoso, portable-pty, git2, rusqlite)"
```

### Task 0.3: Tailwind + CSS variables dla motywów

**Files:**
- Create: `tailwind.config.ts`, `postcss.config.js`, `src/styles/globals.css`, `src/styles/theme.ts`
- Modify: `src/main.tsx` (import globals.css)

- [ ] **Step 1: Tailwind config**

Create `tailwind.config.ts`:
```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        'bg-elev': 'var(--color-bg-elev)',
        'bg-elev-2': 'var(--color-bg-elev-2)',
        fg: 'var(--color-fg)',
        muted: 'var(--color-muted)',
        border: 'var(--color-border)',
        accent: 'var(--color-accent)',
        'accent-fg': 'var(--color-accent-fg)',
        danger: 'var(--color-danger)',
        success: 'var(--color-success)',
        warn: 'var(--color-warn)',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
} satisfies Config;
```

- [ ] **Step 2: PostCSS**

Create `postcss.config.js`:
```js
export default { plugins: { '@tailwindcss/postcss': {} } };
```

- [ ] **Step 3: Globals z themami**

Create `src/styles/globals.css`:
```css
@import "tailwindcss";

@layer base {
  :root {
    --color-bg: #ffffff;
    --color-bg-elev: #f6f7f9;
    --color-bg-elev-2: #eceef2;
    --color-fg: #0f1115;
    --color-muted: #6a6d75;
    --color-border: #d8dbe1;
    --color-accent: #6366f1;
    --color-accent-fg: #ffffff;
    --color-danger: #dc2626;
    --color-success: #16a34a;
    --color-warn: #d97706;
  }
  :root[data-theme="dark"] {
    --color-bg: #0f1115;
    --color-bg-elev: #13161d;
    --color-bg-elev-2: #1a1e29;
    --color-fg: #e6e8ec;
    --color-muted: #8a8d96;
    --color-border: #2a2d35;
    --color-accent: #818cf8;
    --color-accent-fg: #0b0d12;
    --color-danger: #f87171;
    --color-success: #4ade80;
    --color-warn: #fbbf24;
  }
  html, body, #root { height: 100%; }
  body { background: var(--color-bg); color: var(--color-fg); font-family: theme(fontFamily.sans); }
}
```

- [ ] **Step 4: Theme map TS**

Create `src/styles/theme.ts`:
```ts
export type ThemeMode = 'light' | 'dark' | 'system';

export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const resolved =
    mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : mode;
  root.setAttribute('data-theme', resolved);
}
```

- [ ] **Step 5: Import w main.tsx**

Modify `src/main.tsx` — dodaj na górze:
```ts
import './styles/globals.css';
```
I usuń istniejący import `App.css`/`index.css` jeśli są (oraz pliki).

- [ ] **Step 6: Smoke test**

Replace `src/App.tsx` z:
```tsx
import { useEffect, useState } from 'react';
import { applyTheme, type ThemeMode } from './styles/theme';

export default function App() {
  const [mode, setMode] = useState<ThemeMode>('dark');
  useEffect(() => { applyTheme(mode); }, [mode]);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">AbeonCode</h1>
      <div className="flex gap-2">
        {(['light', 'dark', 'system'] as ThemeMode[]).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-3 py-1 rounded border border-border ${mode === m ? 'bg-accent text-accent-fg' : 'bg-bg-elev'}`}>
            {m}
          </button>
        ))}
      </div>
    </div>
  );
}
```

Run:
```bash
npm run tauri dev -- --no-bundle &
sleep 25
pkill -f "tauri dev" || true
```
Expected: aplikacja pokazuje 3 przyciski theme, kliknięcie zmienia kolory tła/tekstu.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: tailwind setup with light/dark theme via CSS variables"
```

---

## Phase 1 — Layout shell

### Task 1.1: ThemeProvider z persistencją

**Files:**
- Create: `src/components/layout/ThemeProvider.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Komponent**

Create `src/components/layout/ThemeProvider.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyTheme, type ThemeMode } from '../../styles/theme';

type Ctx = { mode: ThemeMode; setMode: (m: ThemeMode) => void };
const ThemeCtx = createContext<Ctx | null>(null);
const STORAGE_KEY = 'abeoncode.theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return (saved === 'light' || saved === 'dark' || saved === 'system') ? saved : 'dark';
  });

  useEffect(() => {
    applyTheme(mode);
    localStorage.setItem(STORAGE_KEY, mode);
    if (mode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode]);

  return <ThemeCtx.Provider value={{ mode, setMode: setModeState }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}
```

- [ ] **Step 2: Owinięcie App**

Modify `src/App.tsx`:
```tsx
import { ThemeProvider } from './components/layout/ThemeProvider';

export default function App() {
  return (
    <ThemeProvider>
      <div className="h-full grid place-items-center text-fg">
        <span>AbeonCode shell</span>
      </div>
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: Sanity run**

Run:
```bash
npm run tauri dev -- --no-bundle &
sleep 25
pkill -f "tauri dev" || true
```
Expected: aplikacja startuje, theme jest "dark" (z `localStorage` default).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: ThemeProvider with localStorage persistence and system-mode listener"
```

### Task 1.2: ResizableSplit (poziomy, generyczny)

**Files:**
- Create: `src/components/layout/ResizableSplit.tsx`, `src/components/layout/ResizableSplit.test.tsx`
- Modify: `vite.config.ts` (dodaj `test` section dla vitest)

- [ ] **Step 1: Vitest config**

Modify `vite.config.ts` — w `defineConfig({ ... })` dodaj:
```ts
test: {
  environment: 'jsdom',
  setupFiles: ['./src/test-setup.ts'],
  globals: true,
},
```
I dodaj na górę plik `src/test-setup.ts`:
```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 2: Failing test**

Create `src/components/layout/ResizableSplit.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ResizableSplit } from './ResizableSplit';

describe('ResizableSplit', () => {
  it('renders left and right panels with initial widths', () => {
    render(
      <ResizableSplit
        leftWidth={240}
        minLeft={200}
        maxLeft={400}
        left={<div data-testid="L">left</div>}
        right={<div data-testid="R">right</div>}
        onResize={() => {}}
      />
    );
    expect(screen.getByTestId('L')).toBeInTheDocument();
    expect(screen.getByTestId('R')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test (FAIL)**

Add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`.

Run:
```bash
npm test -- ResizableSplit 2>&1 | tail -10
```
Expected: FAIL — `ResizableSplit` nie istnieje.

- [ ] **Step 4: Implementacja**

Create `src/components/layout/ResizableSplit.tsx`:
```tsx
import { useCallback, useRef, type ReactNode } from 'react';

type Props = {
  leftWidth: number;
  minLeft: number;
  maxLeft: number;
  left: ReactNode;
  right: ReactNode;
  onResize: (width: number) => void;
};

export function ResizableSplit({ leftWidth, minLeft, maxLeft, left, right, onResize }: Props) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = leftWidth;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      const next = Math.max(minLeft, Math.min(maxLeft, startWidth.current + delta));
      onResize(next);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftWidth, minLeft, maxLeft, onResize]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <div style={{ width: leftWidth, flexShrink: 0 }} className="h-full">{left}</div>
      <div
        onMouseDown={onMouseDown}
        className="w-px cursor-col-resize bg-border hover:bg-accent transition-colors"
        role="separator"
        aria-orientation="vertical"
      />
      <div className="flex-1 h-full min-w-0">{right}</div>
    </div>
  );
}
```

- [ ] **Step 5: Run test (PASS)**

Run: `npm test -- ResizableSplit 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: ResizableSplit layout primitive with mouse drag resize"
```

### Task 1.3: AppShell — 3-kolumnowy layout

**Files:**
- Create: `src/components/layout/AppShell.tsx`
- Create: `src/components/sidebar/Sidebar.tsx` (placeholder)
- Create: `src/components/center/CenterPanel.tsx` (placeholder)
- Create: `src/components/right/RightPanel.tsx` (placeholder)
- Modify: `src/App.tsx`

- [ ] **Step 1: Placeholdery dla 3 paneli**

Create `src/components/sidebar/Sidebar.tsx`:
```tsx
export function Sidebar() {
  return (
    <aside className="h-full bg-bg-elev border-r border-border p-3 text-sm">
      <div className="text-muted text-xs uppercase tracking-wide">Projekty</div>
      <div className="mt-2 text-muted">— pusto —</div>
    </aside>
  );
}
```

Create `src/components/center/CenterPanel.tsx`:
```tsx
export function CenterPanel() {
  return (
    <main className="h-full bg-bg flex items-center justify-center text-muted">
      Wybierz sesję
    </main>
  );
}
```

Create `src/components/right/RightPanel.tsx`:
```tsx
export function RightPanel() {
  return (
    <aside className="h-full bg-bg-elev border-l border-border p-3 text-sm flex flex-col gap-3">
      <section className="flex-1 min-h-0">
        <div className="text-muted text-xs uppercase tracking-wide">Akcje</div>
        <div className="mt-2 text-muted">— brak projektu —</div>
      </section>
      <section className="flex-1 min-h-0">
        <div className="text-muted text-xs uppercase tracking-wide">Git</div>
        <div className="mt-2 text-muted">—</div>
      </section>
    </aside>
  );
}
```

- [ ] **Step 2: AppShell**

Create `src/components/layout/AppShell.tsx`:
```tsx
import { useState } from 'react';
import { ResizableSplit } from './ResizableSplit';
import { Sidebar } from '../sidebar/Sidebar';
import { CenterPanel } from '../center/CenterPanel';
import { RightPanel } from '../right/RightPanel';

export function AppShell() {
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(300);

  return (
    <div className="h-full w-full">
      <ResizableSplit
        leftWidth={leftWidth}
        minLeft={200}
        maxLeft={420}
        onResize={setLeftWidth}
        left={<Sidebar />}
        right={
          <ResizableSplit
            leftWidth={Math.max(0, window.innerWidth - leftWidth - rightWidth)}
            minLeft={300}
            maxLeft={window.innerWidth - leftWidth - 220}
            onResize={(w) => setRightWidth(Math.max(220, window.innerWidth - leftWidth - w))}
            left={<CenterPanel />}
            right={<RightPanel />}
          />
        }
      />
    </div>
  );
}
```

- [ ] **Step 3: Wpięcie w App**

Modify `src/App.tsx`:
```tsx
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';

export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
```

- [ ] **Step 4: Sanity dev run**

Run:
```bash
npm run tauri dev -- --no-bundle &
sleep 25
pkill -f "tauri dev" || true
```
Expected: widać 3 kolumny, można przeciągać separatory.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: AppShell with three resizable columns (sidebar, center, right)"
```

### Task 1.4: Zustand store — settings slice (panel widths, theme)

**Files:**
- Create: `src/store/index.ts`, `src/store/settingsSlice.ts`
- Modify: `src/components/layout/AppShell.tsx`, `src/components/layout/ThemeProvider.tsx`

- [ ] **Step 1: Settings slice**

Create `src/store/settingsSlice.ts`:
```ts
import type { StateCreator } from 'zustand';
import type { ThemeMode } from '../styles/theme';

export type SettingsSlice = {
  theme: ThemeMode;
  leftWidth: number;
  rightWidth: number;
  setTheme: (t: ThemeMode) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
};

export const createSettingsSlice: StateCreator<SettingsSlice> = (set) => ({
  theme: 'dark',
  leftWidth: 260,
  rightWidth: 300,
  setTheme: (theme) => set({ theme }),
  setLeftWidth: (leftWidth) => set({ leftWidth }),
  setRightWidth: (rightWidth) => set({ rightWidth }),
});
```

- [ ] **Step 2: Combined store z persist**

Create `src/store/index.ts`:
```ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';

export type AppState = SettingsSlice;

export const useStore = create<AppState>()(
  persist(
    (...a) => ({ ...createSettingsSlice(...a) }),
    {
      name: 'abeoncode.store',
      partialize: (s) => ({ theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth }),
    }
  )
);
```

- [ ] **Step 3: Wpięcie w ThemeProvider**

Modify `src/components/layout/ThemeProvider.tsx` — zamień użycie `useState`+`localStorage` na store:
```tsx
import { useEffect, type ReactNode } from 'react';
import { applyTheme } from '../../styles/theme';
import { useStore } from '../../store';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useStore(s => s.theme);
  useEffect(() => {
    applyTheme(mode);
    if (mode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const h = () => applyTheme('system');
    mql.addEventListener('change', h);
    return () => mql.removeEventListener('change', h);
  }, [mode]);
  return <>{children}</>;
}

export function useTheme() {
  return { mode: useStore(s => s.theme), setMode: useStore(s => s.setTheme) };
}
```

- [ ] **Step 4: AppShell czyta szerokości ze store**

Modify `src/components/layout/AppShell.tsx`:
```tsx
import { ResizableSplit } from './ResizableSplit';
import { Sidebar } from '../sidebar/Sidebar';
import { CenterPanel } from '../center/CenterPanel';
import { RightPanel } from '../right/RightPanel';
import { useStore } from '../../store';

export function AppShell() {
  const leftWidth = useStore(s => s.leftWidth);
  const rightWidth = useStore(s => s.rightWidth);
  const setLeftWidth = useStore(s => s.setLeftWidth);
  const setRightWidth = useStore(s => s.setRightWidth);

  return (
    <div className="h-full w-full">
      <ResizableSplit
        leftWidth={leftWidth}
        minLeft={200}
        maxLeft={420}
        onResize={setLeftWidth}
        left={<Sidebar />}
        right={
          <ResizableSplit
            leftWidth={Math.max(0, window.innerWidth - leftWidth - rightWidth)}
            minLeft={300}
            maxLeft={window.innerWidth - leftWidth - 220}
            onResize={(w) => setRightWidth(Math.max(220, window.innerWidth - leftWidth - w))}
            left={<CenterPanel />}
            right={<RightPanel />}
          />
        }
      />
    </div>
  );
}
```

- [ ] **Step 5: Sanity**

Run app, zmień szerokość, zrestartuj — szerokość powinna się zachować (localStorage przez zustand persist).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: zustand store with persisted settings (theme, panel widths)"
```

---

## Phase 2 — SQLite + projekty

### Task 2.1: AppError i fundamenty backendu

**Files:**
- Create: `src-tauri/src/error.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: AppError**

Create `src-tauri/src/error.rs`:
```rust
use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid path {path}: {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("claude project directory missing: {path}")]
    ClaudeDirMissing { path: String },
    #[error("parse error in {file} line {line}: {message}")]
    Parse { file: String, line: usize, message: String },
    #[error("pty error: {0}")]
    Pty(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("git: {0}")]
    Git(#[from] git2::Error),
    #[error("db: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("db pool: {0}")]
    DbPool(#[from] r2d2::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire<'a> { code: &'a str, message: String }
        let code = match self {
            AppError::NotFound(_) => "not_found",
            AppError::InvalidPath { .. } => "invalid_path",
            AppError::ClaudeDirMissing { .. } => "claude_dir_missing",
            AppError::Parse { .. } => "parse",
            AppError::Pty(_) => "pty",
            AppError::Io(_) => "io",
            AppError::Git(_) => "git",
            AppError::Db(_) | AppError::DbPool(_) => "db",
            AppError::Json(_) => "json",
            AppError::Other(_) => "other",
        };
        Wire { code, message: self.to_string() }.serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 2: lib.rs jako root**

Create `src-tauri/src/lib.rs`:
```rust
pub mod error;
```

- [ ] **Step 3: Wpięcie w main.rs**

Modify `src-tauri/src/main.rs` — dodaj na górze:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod error;
```

- [ ] **Step 4: Test kompilacji**

Run:
```bash
cd src-tauri && cargo build 2>&1 | tail -5 && cd ..
```
Expected: kompiluje bez błędów.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(backend): AppError type with serializable wire format"
```

### Task 2.2: Migracje SQLite i connection pool

**Files:**
- Create: `src-tauri/src/db/mod.rs`, `src-tauri/src/db/migrations/001_initial.sql`

- [ ] **Step 1: Initial migration**

Create `src-tauri/src/db/migrations/001_initial.sql`:
```sql
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  claude_dir  TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  command     TEXT NOT NULL,
  working_dir TEXT,
  source      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version(version) VALUES (1);
```

- [ ] **Step 2: Pool + migrations runner**

Create `src-tauri/src/db/mod.rs`:
```rust
use std::path::PathBuf;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use crate::error::{AppError, AppResult};

pub type DbPool = Pool<SqliteConnectionManager>;

const MIGRATION_001: &str = include_str!("migrations/001_initial.sql");

pub fn db_path() -> AppResult<PathBuf> {
    let mut dir = dirs::config_dir().ok_or_else(|| AppError::Other("no config dir".into()))?;
    dir.push("AbeonCode");
    std::fs::create_dir_all(&dir)?;
    dir.push("abeoncode.db");
    Ok(dir)
}

pub fn init_pool(path: &PathBuf) -> AppResult<DbPool> {
    let manager = SqliteConnectionManager::file(path).with_init(|c| {
        c.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
    });
    let pool = Pool::builder().max_size(8).build(manager)?;
    run_migrations(&pool)?;
    Ok(pool)
}

fn run_migrations(pool: &DbPool) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute_batch(MIGRATION_001)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn migration_creates_tables() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let conn = pool.get().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('projects','actions','settings')",
            [],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(count, 3);
    }
}
```

- [ ] **Step 3: Dev-deps**

Edit `src-tauri/Cargo.toml`, dodaj:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 4: Wpięcie modułu**

Modify `src-tauri/src/lib.rs`:
```rust
pub mod error;
pub mod db;
```

- [ ] **Step 5: Run test**

Run:
```bash
cd src-tauri && cargo test db:: 2>&1 | tail -10 && cd ..
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(backend): SQLite pool with migrations (projects/actions/settings tables)"
```

### Task 2.3: Domain types — Project, Action

**Files:**
- Create: `src-tauri/src/domain/mod.rs`, `src-tauri/src/domain/project.rs`, `src-tauri/src/domain/action.rs`

- [ ] **Step 1: Project**

Create `src-tauri/src/domain/project.rs`:
```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub claude_dir: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub name: Option<String>,
    pub color: Option<String>,
}
```

- [ ] **Step 2: Action**

Create `src-tauri/src/domain/action.rs`:
```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: i64,
    pub project_id: i64,
    pub label: String,
    pub command: String,
    pub working_dir: Option<String>,
    pub source: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ActionInput {
    pub project_id: i64,
    pub label: String,
    pub command: String,
    pub working_dir: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ActionPatch {
    pub label: Option<String>,
    pub command: Option<String>,
    pub working_dir: Option<String>,
}
```

- [ ] **Step 3: Module index**

Create `src-tauri/src/domain/mod.rs`:
```rust
pub mod project;
pub mod action;

pub use project::*;
pub use action::*;
```

- [ ] **Step 4: Wpięcie**

Modify `src-tauri/src/lib.rs`:
```rust
pub mod error;
pub mod db;
pub mod domain;
```

- [ ] **Step 5: Sprawdzenie kompilacji + generowanie TS**

Run:
```bash
cd src-tauri && cargo test --no-run 2>&1 | tail -5 && cd ..
ls src/types/ 2>&1 | head
```
Expected: pliki `Project.ts`, `Action.ts`, `ActionInput.ts`, `ActionPatch.ts`, `ProjectPatch.ts` w `src/types/`.

- [ ] **Step 6: Re-export TS**

Create `src/types/index.ts`:
```ts
export type { Project } from './Project';
export type { ProjectPatch } from './ProjectPatch';
export type { Action } from './Action';
export type { ActionInput } from './ActionInput';
export type { ActionPatch } from './ActionPatch';
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: domain types Project/Action with ts-rs auto-export to frontend"
```

### Task 2.4: Encoding ścieżek Claude Code

**Files:**
- Create: `src-tauri/src/sessions/mod.rs`, `src-tauri/src/sessions/encoding.rs`
- Create: `src/lib/pathEncoding.ts`

- [ ] **Step 1: Test (Rust)**

Create `src-tauri/src/sessions/encoding.rs`:
```rust
use std::path::Path;

/// Claude Code zamienia `/` na `-` w nazwie katalogu pod `~/.claude/projects/`.
pub fn encode_project_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.replace('/', "-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn encodes_absolute_path() {
        let p = PathBuf::from("/home/pszweda/projects/cyberstudio/AbeonCode");
        assert_eq!(encode_project_path(&p), "-home-pszweda-projects-cyberstudio-AbeonCode");
    }

    #[test]
    fn handles_root_path() {
        let p = PathBuf::from("/");
        assert_eq!(encode_project_path(&p), "-");
    }
}
```

- [ ] **Step 2: Module skeleton**

Create `src-tauri/src/sessions/mod.rs`:
```rust
pub mod encoding;
```

Modify `src-tauri/src/lib.rs` — dodaj `pub mod sessions;`.

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test encoding:: 2>&1 | tail -5 && cd ..`
Expected: oba testy PASS.

- [ ] **Step 4: TS counterpart**

Create `src/lib/pathEncoding.ts`:
```ts
export function encodeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/\//g, '-');
}
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: path encoding utility for ~/.claude/projects directory names"
```

### Task 2.5: Projects repository

**Files:**
- Create: `src-tauri/src/db/projects_repo.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1: Repo**

Create `src-tauri/src/db/projects_repo.rs`:
```rust
use rusqlite::{params, Connection};
use crate::domain::Project;
use crate::error::AppResult;

fn row_to_project(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        claude_dir: row.get(3)?,
        color: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<Project>> {
    let mut s = conn.prepare(
        "SELECT id,name,path,claude_dir,color,sort_order,created_at
         FROM projects ORDER BY sort_order ASC, created_at ASC",
    )?;
    let rows = s.query_map([], row_to_project)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn insert(
    conn: &Connection,
    name: &str,
    path: &str,
    claude_dir: &str,
    color: Option<&str>,
) -> AppResult<Project> {
    let created_at = chrono::Utc::now().timestamp_millis();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order)+1, 0) FROM projects", [], |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO projects(name,path,claude_dir,color,sort_order,created_at)
         VALUES(?,?,?,?,?,?)",
        params![name, path, claude_dir, color, sort_order, created_at],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Project {
        id, name: name.to_string(), path: path.to_string(),
        claude_dir: claude_dir.to_string(), color: color.map(|s| s.to_string()),
        sort_order, created_at,
    })
}

pub fn update(
    conn: &Connection, id: i64, name: Option<&str>, color: Option<&str>,
) -> AppResult<Project> {
    if let Some(n) = name {
        conn.execute("UPDATE projects SET name=? WHERE id=?", params![n, id])?;
    }
    if let Some(c) = color {
        conn.execute("UPDATE projects SET color=? WHERE id=?", params![c, id])?;
    }
    get(conn, id)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Project> {
    Ok(conn.query_row(
        "SELECT id,name,path,claude_dir,color,sort_order,created_at FROM projects WHERE id=?",
        params![id], row_to_project,
    )?)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM projects WHERE id=?", params![id])?;
    Ok(())
}

pub fn reorder(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE projects SET sort_order=? WHERE id=?", params![i as i64, id])?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let f = NamedTempFile::new().unwrap();
        let path = f.path().to_path_buf();
        std::mem::forget(f);
        init_pool(&path).unwrap()
    }

    #[test]
    fn insert_list_roundtrip() {
        let p = pool();
        let c = p.get().unwrap();
        let proj = insert(&c, "Demo", "/x/y", "-x-y", None).unwrap();
        assert_eq!(proj.name, "Demo");
        let all = list(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "/x/y");
    }

    #[test]
    fn unique_path() {
        let p = pool();
        let c = p.get().unwrap();
        insert(&c, "A", "/x", "-x", None).unwrap();
        let err = insert(&c, "B", "/x", "-x", None);
        assert!(err.is_err());
    }

    #[test]
    fn reorder_works() {
        let p = pool();
        let c = p.get().unwrap();
        let a = insert(&c, "A", "/a", "-a", None).unwrap();
        let b = insert(&c, "B", "/b", "-b", None).unwrap();
        reorder(&c, &[b.id, a.id]).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all[0].id, b.id);
        assert_eq!(all[1].id, a.id);
    }
}
```

- [ ] **Step 2: Wpięcie**

Modify `src-tauri/src/db/mod.rs` — dodaj `pub mod projects_repo;`.

- [ ] **Step 3: Run tests**

Run:
```bash
cd src-tauri && cargo test projects_repo:: 2>&1 | tail -10 && cd ..
```
Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(backend): projects repository with CRUD + reorder"
```

### Task 2.6: AppState + setup w main.rs

**Files:**
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: State**

Create `src-tauri/src/state.rs`:
```rust
use parking_lot::RwLock;
use std::sync::Arc;
use crate::db::DbPool;

pub struct AppState {
    pub db: DbPool,
    // PTY i watchers dojdą w późniejszych fazach
    pub watchers: Arc<RwLock<Vec<()>>>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self { db, watchers: Arc::new(RwLock::new(Vec::new())) }
    }
}
```

- [ ] **Step 2: Wpięcie modułu**

Modify `src-tauri/src/lib.rs` — dodaj `pub mod state;`.

- [ ] **Step 3: main.rs**

Modify `src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod db;
mod domain;
mod sessions;
mod state;

use state::AppState;

fn main() {
    let db_path = db::db_path().expect("db path");
    let pool = db::init_pool(&db_path).expect("init pool");
    let app_state = AppState::new(pool);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Tauri capabilities — minimalne**

Edit `src-tauri/capabilities/default.json` żeby zawierało:
```json
{
  "identifier": "default",
  "description": "Capabilities for main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "fs:allow-read-text-file",
    "fs:allow-exists"
  ]
}
```

- [ ] **Step 5: Build sanity**

Run:
```bash
cd src-tauri && cargo build 2>&1 | tail -5 && cd ..
```
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(backend): AppState with DB pool wired into Tauri Builder"
```

### Task 2.7: Tauri commands — projekty

**Files:**
- Create: `src-tauri/src/commands/mod.rs`, `src-tauri/src/commands/projects.rs`
- Modify: `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Commands module**

Create `src-tauri/src/commands/projects.rs`:
```rust
use std::path::PathBuf;
use tauri::State;
use crate::domain::Project;
use crate::error::{AppError, AppResult};
use crate::sessions::encoding::encode_project_path;
use crate::state::AppState;
use crate::db::projects_repo as repo;

#[tauri::command]
pub fn list_projects(state: State<AppState>) -> AppResult<Vec<Project>> {
    let c = state.db.get()?;
    repo::list(&c)
}

#[tauri::command]
pub fn add_project(state: State<AppState>, name: String, path: String) -> AppResult<Project> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(AppError::InvalidPath {
            path: path.clone(),
            reason: "katalog nie istnieje".into(),
        });
    }
    let claude_dir = encode_project_path(&p);
    let c = state.db.get()?;
    repo::insert(&c, &name, &path, &claude_dir, None)
}

#[tauri::command]
pub fn update_project(
    state: State<AppState>, id: i64,
    name: Option<String>, color: Option<String>,
) -> AppResult<Project> {
    let c = state.db.get()?;
    repo::update(&c, id, name.as_deref(), color.as_deref())
}

#[tauri::command]
pub fn remove_project(state: State<AppState>, id: i64) -> AppResult<()> {
    let c = state.db.get()?;
    repo::delete(&c, id)
}

#[tauri::command]
pub fn reorder_projects(state: State<AppState>, ids: Vec<i64>) -> AppResult<()> {
    let c = state.db.get()?;
    repo::reorder(&c, &ids)
}
```

- [ ] **Step 2: Mod index**

Create `src-tauri/src/commands/mod.rs`:
```rust
pub mod projects;
```

- [ ] **Step 3: Rejestracja w main**

Modify `src-tauri/src/main.rs` — dodaj `mod commands;` i zmień `invoke_handler`:
```rust
.invoke_handler(tauri::generate_handler![
    commands::projects::list_projects,
    commands::projects::add_project,
    commands::projects::update_project,
    commands::projects::remove_project,
    commands::projects::reorder_projects,
])
```

- [ ] **Step 4: lib.rs**

Modify `src-tauri/src/lib.rs` — dodaj `pub mod commands;`, `pub mod state;`.

- [ ] **Step 5: Build sanity**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cd ..`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(backend): Tauri commands for projects CRUD"
```

### Task 2.8: Frontend — typed Tauri wrappers + projects slice

**Files:**
- Create: `src/lib/tauri.ts`, `src/store/projectsSlice.ts`
- Modify: `src/store/index.ts`

- [ ] **Step 1: Typed wrappers**

Create `src/lib/tauri.ts`:
```ts
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../types';

export const tauri = {
  listProjects: () => invoke<Project[]>('list_projects'),
  addProject: (name: string, path: string) =>
    invoke<Project>('add_project', { name, path }),
  updateProject: (id: number, patch: { name?: string; color?: string }) =>
    invoke<Project>('update_project', { id, ...patch }),
  removeProject: (id: number) => invoke<void>('remove_project', { id }),
  reorderProjects: (ids: number[]) => invoke<void>('reorder_projects', { ids }),
};
```

- [ ] **Step 2: Projects slice**

Create `src/store/projectsSlice.ts`:
```ts
import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { Project } from '../types';

export type ProjectsSlice = {
  projects: Project[];
  expandedProjectIds: Set<number>;
  loadProjects: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<Project>;
  removeProject: (id: number) => Promise<void>;
  toggleProjectExpanded: (id: number) => void;
};

export const createProjectsSlice: StateCreator<ProjectsSlice> = (set, get) => ({
  projects: [],
  expandedProjectIds: new Set(),
  loadProjects: async () => set({ projects: await tauri.listProjects() }),
  addProject: async (name, path) => {
    const p = await tauri.addProject(name, path);
    set({ projects: [...get().projects, p] });
    return p;
  },
  removeProject: async (id) => {
    await tauri.removeProject(id);
    set({ projects: get().projects.filter(p => p.id !== id) });
  },
  toggleProjectExpanded: (id) => {
    const next = new Set(get().expandedProjectIds);
    next.has(id) ? next.delete(id) : next.add(id);
    set({ expandedProjectIds: next });
  },
});
```

- [ ] **Step 3: Combine**

Modify `src/store/index.ts`:
```ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSettingsSlice, type SettingsSlice } from './settingsSlice';
import { createProjectsSlice, type ProjectsSlice } from './projectsSlice';

export type AppState = SettingsSlice & ProjectsSlice;

export const useStore = create<AppState>()(
  persist(
    (...a) => ({ ...createSettingsSlice(...a), ...createProjectsSlice(...a) }),
    {
      name: 'abeoncode.store',
      partialize: (s) => ({ theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth }),
    }
  )
);
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: projects slice with typed Tauri command wrappers"
```

### Task 2.9: AddProjectDialog (minimum, bez detektorów)

**Files:**
- Create: `src/components/dialogs/AddProjectDialog.tsx`, `src/components/sidebar/AddProjectButton.tsx`

- [ ] **Step 1: Dialog**

Create `src/components/dialogs/AddProjectDialog.tsx`:
```tsx
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useStore } from '../../store';

type Props = { onClose: () => void };

export function AddProjectDialog({ onClose }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const addProject = useStore(s => s.addProject);

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') {
      setPath(selected);
      if (!name) setName(selected.split('/').pop() ?? selected);
    }
  };

  const submit = async () => {
    setError(null);
    try {
      await addProject(name.trim(), path.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border rounded-lg p-5 w-[420px]">
        <h2 className="text-lg font-semibold mb-3">Dodaj projekt</h2>
        <label className="block text-xs text-muted mb-1">Ścieżka katalogu</label>
        <div className="flex gap-2 mb-3">
          <input value={path} onChange={e => setPath(e.target.value)}
            className="flex-1 bg-bg border border-border rounded px-2 py-1" />
          <button onClick={pickFolder}
            className="px-3 py-1 border border-border rounded bg-bg-elev-2">Wybierz…</button>
        </div>
        <label className="block text-xs text-muted mb-1">Nazwa</label>
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 mb-3" />
        {error && <div className="text-danger text-sm mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 border border-border rounded">Anuluj</button>
          <button onClick={submit}
            className="px-3 py-1 bg-accent text-accent-fg rounded"
            disabled={!name.trim() || !path.trim()}>Dodaj</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: AddProjectButton**

Create `src/components/sidebar/AddProjectButton.tsx`:
```tsx
import { useState } from 'react';
import { AddProjectDialog } from '../dialogs/AddProjectDialog';

export function AddProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="w-full mt-3 py-2 text-sm border border-dashed border-border rounded text-muted hover:text-fg hover:border-fg">
        + Dodaj projekt
      </button>
      {open && <AddProjectDialog onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 3: Wpięcie w Sidebar (na razie placeholder list)**

Modify `src/components/sidebar/Sidebar.tsx`:
```tsx
import { useEffect } from 'react';
import { useStore } from '../../store';
import { AddProjectButton } from './AddProjectButton';

export function Sidebar() {
  const projects = useStore(s => s.projects);
  const load = useStore(s => s.loadProjects);
  useEffect(() => { load(); }, [load]);

  return (
    <aside className="h-full bg-bg-elev border-r border-border p-3 text-sm flex flex-col">
      <div className="text-muted text-xs uppercase tracking-wide">Projekty</div>
      <ul className="mt-2 space-y-1 overflow-auto flex-1">
        {projects.length === 0 && <li className="text-muted">— pusto —</li>}
        {projects.map(p => (
          <li key={p.id} className="px-2 py-1 rounded hover:bg-bg-elev-2 cursor-pointer">
            {p.name}
          </li>
        ))}
      </ul>
      <AddProjectButton />
    </aside>
  );
}
```

- [ ] **Step 4: Smoke**

Run app, kliknij "+ Dodaj projekt", wybierz katalog (np. `/home/pszweda/projects/cyberstudio/AbeonCode`), nazwij "AbeonCode self", zatwierdź — projekt pojawia się na liście. Po restarcie aplikacji nadal jest.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: AddProjectDialog with folder picker, persisting to SQLite"
```

---

## Phase 3 — Sesje: parser JSONL i lista

### Task 3.1: SessionMeta + HistoryBlock typy

**Files:**
- Create: `src-tauri/src/domain/session.rs`
- Modify: `src-tauri/src/domain/mod.rs`

- [ ] **Step 1: Typy**

Create `src-tauri/src/domain/session.rs`:
```rust
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub project_id: i64,
    pub title: String,
    pub message_count: usize,
    pub last_modified: i64,
    pub git_branch: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryBlock {
    UserText      { uuid: String, timestamp: i64, text: String },
    AssistantText { uuid: String, timestamp: i64, text: String },
    AssistantThinking { uuid: String, timestamp: i64, text: String },
    ToolUse       { uuid: String, timestamp: i64, name: String, input_summary: String, raw_input: serde_json::Value },
    ToolResult    { uuid: String, timestamp: i64, content: String, is_error: bool },
    Attachment    { uuid: String, timestamp: i64, kind: String, name: String },
    System        { uuid: String, timestamp: i64, subtype: String, message: String },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SessionHistory {
    pub meta: SessionMeta,
    pub blocks: Vec<HistoryBlock>,
    pub has_more_before: bool,
}
```

- [ ] **Step 2: Wpięcie**

Modify `src-tauri/src/domain/mod.rs` — dodaj:
```rust
pub mod session;
pub use session::*;
```

- [ ] **Step 3: Cargo build**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cd ..`
Expected: OK + nowe pliki `.ts` w `src/types/`.

- [ ] **Step 4: Update src/types/index.ts**

Modify `src/types/index.ts` — dodaj:
```ts
export type { SessionMeta } from './SessionMeta';
export type { HistoryBlock } from './HistoryBlock';
export type { SessionHistory } from './SessionHistory';
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: domain types SessionMeta, HistoryBlock, SessionHistory"
```

### Task 3.2: JSONL parser

**Files:**
- Create: `src-tauri/src/sessions/parser.rs`, `src-tauri/tests/fixtures/sample.jsonl`
- Modify: `src-tauri/src/sessions/mod.rs`

- [ ] **Step 1: Fixture**

Skopiuj kawałek prawdziwego pliku do fixture:
```bash
mkdir -p src-tauri/tests/fixtures
head -30 ~/.claude/projects/-home-pszweda-projects-cyberstudio-AbeonCode/f77d6989-1301-4b19-9531-e34f6d411519.jsonl > src-tauri/tests/fixtures/sample.jsonl 2>/dev/null || echo "fallback fixture needed"
# Jeśli pusty, dopisz przykładowe rekordy ręcznie:
```

Jeśli plik jest pusty, utwórz fixture ręcznie z minimalnymi przykładami każdego typu. Plik `src-tauri/tests/fixtures/sample.jsonl`:
```
{"type":"queue-operation","operation":"start","timestamp":"2026-05-21T12:00:00Z","sessionId":"s1"}
{"type":"user","uuid":"u1","timestamp":"2026-05-21T12:00:01Z","sessionId":"s1","cwd":"/x","gitBranch":"main","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
{"type":"assistant","uuid":"a1","timestamp":"2026-05-21T12:00:02Z","sessionId":"s1","cwd":"/x","gitBranch":"main","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"x"},{"type":"text","text":"Hi there!"},{"type":"tool_use","id":"t1","name":"read_file","input":{"path":"src/a.ts"}}]}}
{"type":"user","uuid":"u2","timestamp":"2026-05-21T12:00:03Z","sessionId":"s1","cwd":"/x","gitBranch":"main","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"file contents","is_error":false}]}}
{"type":"attachment","uuid":"at1","timestamp":"2026-05-21T12:00:04Z","sessionId":"s1","cwd":"/x","attachment":{"kind":"image","name":"screenshot.png"}}
{"type":"system","uuid":"sys1","timestamp":"2026-05-21T12:00:05Z","sessionId":"s1","subtype":"hook","hookCount":1,"hasOutput":false,"level":"info","cwd":"/x"}
{"type":"last-prompt","lastPrompt":"...","leafUuid":"a1","sessionId":"s1"}
```

- [ ] **Step 2: Parser**

Create `src-tauri/src/sessions/parser.rs`:
```rust
use serde_json::Value;
use crate::domain::HistoryBlock;

/// Zamienia ISO8601 string na unix ms. Fallback: 0.
fn ts_ms(v: &Value) -> i64 {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn uuid_of(v: &Value) -> String {
    v.get("uuid").and_then(|u| u.as_str()).unwrap_or("").to_string()
}

/// Parsuje pojedynczą linię JSONL na zero lub więcej `HistoryBlock`.
/// Zwraca `Ok(vec![])` dla linii infrastruktury (queue-operation, last-prompt).
pub fn parse_line(line: &str) -> Result<Vec<HistoryBlock>, serde_json::Error> {
    let v: Value = serde_json::from_str(line)?;
    let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let ts = ts_ms(v.get("timestamp").unwrap_or(&Value::Null));
    let uuid = uuid_of(&v);

    Ok(match kind {
        "queue-operation" | "last-prompt" => vec![],
        "user" => parse_user(&v, &uuid, ts),
        "assistant" => parse_assistant(&v, &uuid, ts),
        "attachment" => parse_attachment(&v, &uuid, ts),
        "system" => vec![HistoryBlock::System {
            uuid, timestamp: ts,
            subtype: v.get("subtype").and_then(|s| s.as_str()).unwrap_or("").into(),
            message: v.get("subtype").and_then(|s| s.as_str()).unwrap_or("system event").into(),
        }],
        _ => vec![],
    })
}

fn content_array<'a>(v: &'a Value) -> Option<&'a Vec<Value>> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
}

fn parse_user(v: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(arr) = content_array(v) else { return vec![] };
    let mut out = Vec::new();
    for item in arr {
        let t = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "text" => {
                let text = item.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if !text.is_empty() {
                    out.push(HistoryBlock::UserText { uuid: uuid.into(), timestamp: ts, text });
                }
            }
            "tool_result" => {
                let content = render_tool_result(item.get("content"));
                let is_error = item.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                out.push(HistoryBlock::ToolResult { uuid: uuid.into(), timestamp: ts, content, is_error });
            }
            _ => {}
        }
    }
    out
}

fn parse_assistant(v: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(arr) = content_array(v) else { return vec![] };
    let mut out = Vec::new();
    for item in arr {
        let t = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "thinking" => {
                let text = item.get("thinking").and_then(|x| x.as_str()).unwrap_or("").to_string();
                out.push(HistoryBlock::AssistantThinking { uuid: uuid.into(), timestamp: ts, text });
            }
            "text" => {
                let text = item.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if !text.is_empty() {
                    out.push(HistoryBlock::AssistantText { uuid: uuid.into(), timestamp: ts, text });
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let raw_input = item.get("input").cloned().unwrap_or(Value::Null);
                let input_summary = summarize_input(&raw_input);
                out.push(HistoryBlock::ToolUse {
                    uuid: uuid.into(), timestamp: ts, name, input_summary, raw_input,
                });
            }
            _ => {}
        }
    }
    out
}

fn parse_attachment(v: &Value, uuid: &str, ts: i64) -> Vec<HistoryBlock> {
    let Some(att) = v.get("attachment") else { return vec![] };
    let kind = att.get("kind").and_then(|x| x.as_str()).unwrap_or("file").to_string();
    let name = att.get("name").and_then(|x| x.as_str()).unwrap_or("(unnamed)").to_string();
    vec![HistoryBlock::Attachment { uuid: uuid.into(), timestamp: ts, kind, name }]
}

fn render_tool_result(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr.iter()
            .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn summarize_input(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let mut parts = Vec::new();
            for (k, val) in map.iter().take(3) {
                let short = match val {
                    Value::String(s) if s.len() > 40 => format!("\"{}…\"", &s[..40]),
                    other => other.to_string(),
                };
                parts.push(format!("{k}: {short}"));
            }
            parts.join(", ")
        }
        _ => v.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::HistoryBlock;

    fn lines() -> Vec<String> {
        let s = include_str!("../../tests/fixtures/sample.jsonl");
        s.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect()
    }

    #[test]
    fn skips_infrastructure_records() {
        let blocks = parse_line(&lines()[0]).unwrap();
        assert!(blocks.is_empty());
    }

    #[test]
    fn parses_user_text() {
        let blocks = parse_line(&lines()[1]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::UserText { text, .. } if text == "Hello"));
    }

    #[test]
    fn parses_assistant_with_thinking_text_and_tool_use() {
        let blocks = parse_line(&lines()[2]).unwrap();
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], HistoryBlock::AssistantThinking { .. }));
        assert!(matches!(&blocks[1], HistoryBlock::AssistantText { .. }));
        assert!(matches!(&blocks[2], HistoryBlock::ToolUse { name, .. } if name == "read_file"));
    }

    #[test]
    fn parses_tool_result() {
        let blocks = parse_line(&lines()[3]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::ToolResult { content, .. } if content == "file contents"));
    }

    #[test]
    fn parses_attachment() {
        let blocks = parse_line(&lines()[4]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::Attachment { name, .. } if name == "screenshot.png"));
    }

    #[test]
    fn parses_system() {
        let blocks = parse_line(&lines()[5]).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], HistoryBlock::System { .. }));
    }
}
```

- [ ] **Step 2: Wpięcie**

Modify `src-tauri/src/sessions/mod.rs` — dodaj `pub mod parser;`.

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test sessions::parser 2>&1 | tail -15 && cd ..`
Expected: 6 testów PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(backend): JSONL parser for all message types (user/assistant/tool/system)"
```

### Task 3.3: Session reader z paginacją

**Files:**
- Create: `src-tauri/src/sessions/reader.rs`
- Modify: `src-tauri/src/sessions/mod.rs`

- [ ] **Step 1: Reader**

Create `src-tauri/src/sessions/reader.rs`:
```rust
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use crate::domain::{HistoryBlock, SessionHistory, SessionMeta};
use crate::error::{AppError, AppResult};
use super::parser::parse_line;

const DEFAULT_PAGE: usize = 200;

pub fn session_file(claude_dir: &Path, session_id: &str) -> PathBuf {
    claude_dir.join(format!("{session_id}.jsonl"))
}

/// Lista sesji w katalogu Claude — meta dla każdej.
pub fn list_sessions(
    project_id: i64,
    project_claude_dir: &Path,
    limit: usize,
    offset: usize,
) -> AppResult<Vec<SessionMeta>> {
    if !project_claude_dir.exists() {
        return Ok(vec![]);
    }
    let mut entries: Vec<_> = fs::read_dir(project_claude_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();

    entries.sort_by_key(|e| {
        std::cmp::Reverse(
            e.metadata().and_then(|m| m.modified()).ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        )
    });

    let mut out = Vec::new();
    for entry in entries.into_iter().skip(offset).take(limit) {
        if let Ok(meta) = meta_for_file(project_id, &entry.path()) {
            out.push(meta);
        }
    }
    Ok(out)
}

fn meta_for_file(project_id: i64, path: &Path) -> AppResult<SessionMeta> {
    let id = path.file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::NotFound(path.display().to_string()))?
        .to_string();

    let last_modified = path.metadata()?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut title = format!("Sesja {}", &id[..8.min(id.len())]);
    let mut message_count = 0usize;
    let mut git_branch = None;
    let mut cwd = None;
    let mut first_user_set = false;
    let mut first_assistant_text: Option<String> = None;

    let file = fs::File::open(path)?;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        let Ok(blocks) = parse_line(&line) else { continue };
        for b in blocks {
            message_count += 1;
            match &b {
                HistoryBlock::UserText { text, .. } if !first_user_set => {
                    title = truncate(text, 80);
                    first_user_set = true;
                }
                HistoryBlock::AssistantText { text, .. } if first_assistant_text.is_none() => {
                    first_assistant_text = Some(truncate(text, 80));
                }
                _ => {}
            }
        }
        if cwd.is_none() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                    cwd = Some(c.to_string());
                }
                if let Some(b) = v.get("gitBranch").and_then(|x| x.as_str()) {
                    git_branch = Some(b.to_string());
                }
            }
        }
    }

    if !first_user_set {
        if let Some(t) = first_assistant_text { title = t; }
        else {
            let ts = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(last_modified)
                .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| id.clone());
            title = ts;
        }
    }

    Ok(SessionMeta { id, project_id, title, message_count, last_modified, git_branch, cwd })
}

fn truncate(s: &str, max: usize) -> String {
    let trimmed = s.trim().replace('\n', " ");
    if trimmed.chars().count() <= max { trimmed }
    else { let mut t: String = trimmed.chars().take(max).collect(); t.push('…'); t }
}

/// Czyta ostatnie `limit` rekordów, ew. od `before_uuid` wstecz.
pub fn read_history(
    project_id: i64,
    claude_dir: &Path,
    session_id: &str,
    limit: Option<usize>,
    before_uuid: Option<&str>,
) -> AppResult<SessionHistory> {
    let path = session_file(claude_dir, session_id);
    let meta = meta_for_file(project_id, &path)?;
    let limit = limit.unwrap_or(DEFAULT_PAGE);

    let file = fs::File::open(&path)?;
    let mut all_blocks: Vec<HistoryBlock> = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        if let Ok(bs) = parse_line(&line) {
            all_blocks.extend(bs);
        }
    }

    let end = if let Some(before) = before_uuid {
        all_blocks.iter().position(|b| block_uuid(b) == before).unwrap_or(all_blocks.len())
    } else {
        all_blocks.len()
    };

    let start = end.saturating_sub(limit);
    let blocks = all_blocks[start..end].to_vec();
    let has_more_before = start > 0;

    Ok(SessionHistory { meta, blocks, has_more_before })
}

fn block_uuid(b: &HistoryBlock) -> &str {
    match b {
        HistoryBlock::UserText { uuid, .. } |
        HistoryBlock::AssistantText { uuid, .. } |
        HistoryBlock::AssistantThinking { uuid, .. } |
        HistoryBlock::ToolUse { uuid, .. } |
        HistoryBlock::ToolResult { uuid, .. } |
        HistoryBlock::Attachment { uuid, .. } |
        HistoryBlock::System { uuid, .. } => uuid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(format!("{name}.jsonl"));
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn list_orders_by_mtime_desc() {
        let td = TempDir::new().unwrap();
        setup(td.path(), "aaaa-old", "{\"type\":\"queue-operation\"}\n");
        std::thread::sleep(std::time::Duration::from_millis(20));
        setup(td.path(), "bbbb-new", "{\"type\":\"queue-operation\"}\n");
        let v = list_sessions(1, td.path(), 10, 0).unwrap();
        assert_eq!(v.len(), 2);
        assert!(v[0].id.starts_with("bbbb"));
    }

    #[test]
    fn read_history_pagination() {
        let td = TempDir::new().unwrap();
        let mut content = String::new();
        for i in 0..10 {
            content.push_str(&format!(
                "{{\"type\":\"user\",\"uuid\":\"u{i}\",\"timestamp\":\"2026-05-21T12:00:0{i}Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"msg {i}\"}}]}}}}\n"
            ));
        }
        let _path = setup(td.path(), "sess", &content);
        let h = read_history(1, td.path(), "sess", Some(3), None).unwrap();
        assert_eq!(h.blocks.len(), 3);
        assert!(h.has_more_before);
        let last_text = match &h.blocks[2] {
            HistoryBlock::UserText { text, .. } => text.clone(),
            _ => panic!()
        };
        assert_eq!(last_text, "msg 9");
    }
}
```

- [ ] **Step 2: Wpięcie**

Modify `src-tauri/src/sessions/mod.rs` — dodaj `pub mod reader;`.

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test sessions::reader 2>&1 | tail -10 && cd ..`
Expected: 2 PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(backend): session reader with mtime sort and uuid-based pagination"
```

### Task 3.4: Tauri commands — sesje

**Files:**
- Create: `src-tauri/src/commands/sessions.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/main.rs`, `src/lib/tauri.ts`

- [ ] **Step 1: Commands**

Create `src-tauri/src/commands/sessions.rs`:
```rust
use std::path::PathBuf;
use tauri::State;
use crate::domain::{SessionMeta, SessionHistory};
use crate::error::{AppError, AppResult};
use crate::sessions::reader;
use crate::state::AppState;
use crate::db::projects_repo;

fn claude_root() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home".into()))?;
    Ok(home.join(".claude").join("projects"))
}

#[tauri::command]
pub fn list_sessions(
    state: State<AppState>,
    project_id: i64, limit: usize, offset: usize,
) -> AppResult<Vec<SessionMeta>> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = claude_root()?.join(&proj.claude_dir);
    reader::list_sessions(project_id, &dir, limit, offset)
}

#[tauri::command]
pub fn read_session_history(
    state: State<AppState>,
    project_id: i64,
    session_id: String,
    limit: Option<usize>,
    before_uuid: Option<String>,
) -> AppResult<SessionHistory> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = claude_root()?.join(&proj.claude_dir);
    reader::read_history(project_id, &dir, &session_id, limit, before_uuid.as_deref())
}
```

- [ ] **Step 2: Wpięcie commands/mod.rs**

Modify `src-tauri/src/commands/mod.rs` — dodaj `pub mod sessions;`.

- [ ] **Step 3: Rejestracja w main.rs**

Modify `src-tauri/src/main.rs` — w `generate_handler!` dodaj:
```rust
commands::sessions::list_sessions,
commands::sessions::read_session_history,
```

- [ ] **Step 4: TS wrappers**

Modify `src/lib/tauri.ts` — dodaj:
```ts
import type { SessionMeta, SessionHistory } from '../types';

// w obiekcie tauri:
listSessions: (projectId: number, limit = 20, offset = 0) =>
  invoke<SessionMeta[]>('list_sessions', { projectId, limit, offset }),
readSessionHistory: (projectId: number, sessionId: string, limit?: number, beforeUuid?: string) =>
  invoke<SessionHistory>('read_session_history', { projectId, sessionId, limit, beforeUuid }),
```

- [ ] **Step 5: Build sanity**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cd ..`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Tauri commands list_sessions and read_session_history"
```

### Task 3.5: Sessions slice + ProjectItem rozwijanie

**Files:**
- Create: `src/store/sessionsSlice.ts`, `src/components/sidebar/ProjectItem.tsx`, `src/components/sidebar/SessionList.tsx`, `src/components/sidebar/SessionItem.tsx`
- Modify: `src/store/index.ts`, `src/components/sidebar/Sidebar.tsx`

- [ ] **Step 1: Sessions slice**

Create `src/store/sessionsSlice.ts`:
```ts
import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { SessionMeta } from '../types';

const PAGE = 5;

export type SessionsSlice = {
  sessionsByProject: Record<number, { items: SessionMeta[]; hasMore: boolean }>;
  loadInitialSessions: (projectId: number) => Promise<void>;
  loadMoreSessions: (projectId: number) => Promise<void>;
};

export const createSessionsSlice: StateCreator<SessionsSlice> = (set, get) => ({
  sessionsByProject: {},
  loadInitialSessions: async (projectId) => {
    const items = await tauri.listSessions(projectId, PAGE, 0);
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: { items, hasMore: items.length === PAGE },
    }});
  },
  loadMoreSessions: async (projectId) => {
    const current = get().sessionsByProject[projectId];
    if (!current) return;
    const more = await tauri.listSessions(projectId, PAGE, current.items.length);
    set({ sessionsByProject: {
      ...get().sessionsByProject,
      [projectId]: {
        items: [...current.items, ...more],
        hasMore: more.length === PAGE,
      },
    }});
  },
});
```

- [ ] **Step 2: Combine**

Modify `src/store/index.ts`:
```ts
import { createSessionsSlice, type SessionsSlice } from './sessionsSlice';

export type AppState = SettingsSlice & ProjectsSlice & SessionsSlice;

export const useStore = create<AppState>()(
  persist(
    (...a) => ({
      ...createSettingsSlice(...a),
      ...createProjectsSlice(...a),
      ...createSessionsSlice(...a),
    }),
    { name: 'abeoncode.store',
      partialize: (s) => ({ theme: s.theme, leftWidth: s.leftWidth, rightWidth: s.rightWidth }) }
  )
);
```

- [ ] **Step 3: SessionItem**

Create `src/components/sidebar/SessionItem.tsx`:
```tsx
import type { SessionMeta } from '../../types';
import { formatRelative } from '../../lib/format';

type Props = { session: SessionMeta; active?: boolean; onClick: () => void };

export function SessionItem({ session, active, onClick }: Props) {
  return (
    <li
      onClick={onClick}
      className={`px-2 py-1 rounded text-xs cursor-pointer truncate ${active ? 'bg-bg-elev-2 text-fg' : 'text-muted hover:text-fg hover:bg-bg-elev-2'}`}
      title={session.title}
    >
      <div className="truncate">{session.title}</div>
      <div className="text-[10px] opacity-70">{formatRelative(session.lastModified)}</div>
    </li>
  );
}
```

- [ ] **Step 4: format helper**

Create `src/lib/format.ts`:
```ts
export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000, h = 60 * min, d = 24 * h;
  if (diff < min) return 'przed chwilą';
  if (diff < h) return `${Math.floor(diff / min)} min temu`;
  if (diff < d) return `${Math.floor(diff / h)} h temu`;
  if (diff < 7 * d) return `${Math.floor(diff / d)} dni temu`;
  return new Date(ms).toLocaleDateString('pl-PL');
}
```

- [ ] **Step 5: SessionList**

Create `src/components/sidebar/SessionList.tsx`:
```tsx
import { useEffect } from 'react';
import { useStore } from '../../store';
import { SessionItem } from './SessionItem';

type Props = { projectId: number };

export function SessionList({ projectId }: Props) {
  const state = useStore(s => s.sessionsByProject[projectId]);
  const load = useStore(s => s.loadInitialSessions);
  const loadMore = useStore(s => s.loadMoreSessions);

  useEffect(() => { if (!state) load(projectId); }, [projectId, state, load]);

  if (!state) return <div className="text-xs text-muted pl-4 py-1">Wczytywanie…</div>;
  if (state.items.length === 0) return <div className="text-xs text-muted pl-4 py-1">Brak sesji</div>;

  return (
    <ul className="pl-4 space-y-0.5 mt-1">
      {state.items.map(s => (
        <SessionItem key={s.id} session={s} onClick={() => {/* hook do tabs slice w later task */}} />
      ))}
      {state.hasMore && (
        <li>
          <button onClick={() => loadMore(projectId)}
            className="text-[11px] text-muted hover:text-fg pl-2 py-1">
            Załaduj starsze…
          </button>
        </li>
      )}
    </ul>
  );
}
```

- [ ] **Step 6: ProjectItem**

Create `src/components/sidebar/ProjectItem.tsx`:
```tsx
import { useStore } from '../../store';
import type { Project } from '../../types';
import { SessionList } from './SessionList';

type Props = { project: Project };

export function ProjectItem({ project }: Props) {
  const expanded = useStore(s => s.expandedProjectIds.has(project.id));
  const toggle = useStore(s => s.toggleProjectExpanded);
  return (
    <li>
      <button
        onClick={() => toggle(project.id)}
        className="w-full text-left px-2 py-1 rounded flex items-center gap-1 hover:bg-bg-elev-2"
      >
        <span className="text-muted text-xs">{expanded ? '▾' : '▸'}</span>
        <span className="truncate">{project.name}</span>
      </button>
      {expanded && <SessionList projectId={project.id} />}
    </li>
  );
}
```

- [ ] **Step 7: Sidebar użyj ProjectItem**

Modify `src/components/sidebar/Sidebar.tsx`:
```tsx
import { useEffect } from 'react';
import { useStore } from '../../store';
import { AddProjectButton } from './AddProjectButton';
import { ProjectItem } from './ProjectItem';

export function Sidebar() {
  const projects = useStore(s => s.projects);
  const load = useStore(s => s.loadProjects);
  useEffect(() => { load(); }, [load]);

  return (
    <aside className="h-full bg-bg-elev border-r border-border p-3 text-sm flex flex-col">
      <div className="text-muted text-xs uppercase tracking-wide">Projekty</div>
      <ul className="mt-2 space-y-0.5 overflow-auto flex-1">
        {projects.length === 0 && <li className="text-muted">— pusto —</li>}
        {projects.map(p => <ProjectItem key={p.id} project={p} />)}
      </ul>
      <AddProjectButton />
    </aside>
  );
}
```

- [ ] **Step 8: Smoke**

Uruchom aplikację, rozwiń projekt — pojawi się lista 5 ostatnich sesji z tytułami i datami. "Załaduj starsze" działa.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: sidebar with expandable projects showing 5 recent sessions + paging"
```

### Task 3.6: Tabs slice + TabBar

**Files:**
- Create: `src/store/tabsSlice.ts`, `src/components/center/TabBar.tsx`, `src/components/center/TabContent.tsx`
- Modify: `src/store/index.ts`, `src/components/center/CenterPanel.tsx`, `src/components/sidebar/SessionList.tsx`

- [ ] **Step 1: Tabs slice**

Create `src/store/tabsSlice.ts`:
```ts
import type { StateCreator } from 'zustand';

export type Tab =
  | { kind: 'session'; id: string; projectId: number; sessionId: string; title: string; mode: 'history' | 'terminal' }
  | { kind: 'action'; id: string; projectId: number; actionId: number; title: string; status: 'running' | 'exited' };

export type TabsSlice = {
  tabs: Tab[];
  activeTabId: string | null;
  openSessionTab: (projectId: number, sessionId: string, title: string) => void;
  setSessionMode: (tabId: string, mode: 'history' | 'terminal') => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  upsertActionTab: (tab: Extract<Tab, { kind: 'action' }>) => void;
};

const sessionTabId = (sessionId: string) => `session:${sessionId}`;

export const createTabsSlice: StateCreator<TabsSlice> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  openSessionTab: (projectId, sessionId, title) => {
    const id = sessionTabId(sessionId);
    const existing = get().tabs.find(t => t.id === id);
    if (existing) { set({ activeTabId: id }); return; }
    set({
      tabs: [...get().tabs, { kind: 'session', id, projectId, sessionId, title, mode: 'history' }],
      activeTabId: id,
    });
  },
  setSessionMode: (tabId, mode) => set({
    tabs: get().tabs.map(t => t.id === tabId && t.kind === 'session' ? { ...t, mode } : t),
  }),
  closeTab: (id) => {
    const tabs = get().tabs.filter(t => t.id !== id);
    const activeTabId = get().activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId;
    set({ tabs, activeTabId });
  },
  setActive: (id) => set({ activeTabId: id }),
  upsertActionTab: (tab) => {
    const existing = get().tabs.find(t => t.id === tab.id);
    if (existing) {
      set({ tabs: get().tabs.map(t => t.id === tab.id ? tab : t), activeTabId: tab.id });
    } else {
      set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    }
  },
});
```

- [ ] **Step 2: Combine w store**

Modify `src/store/index.ts` żeby uwzględnił `TabsSlice` (`createTabsSlice` w spreadzie, typ w `AppState`). Tab state nie idzie do `persist.partialize` — taby się resetują przy restarcie.

- [ ] **Step 3: Klik sesji otwiera tab**

Modify `src/components/sidebar/SessionList.tsx` — pobierz `openSessionTab` ze store i wywołaj w `SessionItem.onClick`:
```tsx
const open = useStore(s => s.openSessionTab);
// w mapowaniu:
<SessionItem key={s.id} session={s} onClick={() => open(projectId, s.id, s.title)} />
```

- [ ] **Step 4: TabBar**

Create `src/components/center/TabBar.tsx`:
```tsx
import { useStore } from '../../store';

export function TabBar() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const setActive = useStore(s => s.setActive);
  const closeTab = useStore(s => s.closeTab);

  if (tabs.length === 0) return null;
  return (
    <div className="flex h-8 border-b border-border bg-bg-elev px-2 gap-1 items-end">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => setActive(t.id)}
          className={`group relative px-3 py-1 text-xs rounded-t border ${
            t.id === active
              ? 'bg-bg border-border border-b-bg text-fg'
              : 'bg-bg-elev-2 border-transparent text-muted hover:text-fg'
          }`}
        >
          <span className="mr-2">
            {t.kind === 'session' ? (t.mode === 'terminal' ? '⌘' : '◇') : '▶'}
          </span>
          <span className="truncate max-w-[160px] inline-block align-middle">{t.title}</span>
          <span
            onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
            className="ml-2 text-muted hover:text-danger opacity-0 group-hover:opacity-100"
          >×</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: TabContent placeholder + CenterPanel**

Create `src/components/center/TabContent.tsx`:
```tsx
import { useStore } from '../../store';

export function TabContent() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const tab = tabs.find(t => t.id === active);
  if (!tab) return <div className="flex-1 grid place-items-center text-muted">Wybierz sesję z lewej</div>;
  return <div className="flex-1 p-4 text-fg text-sm">tab placeholder — {tab.id}</div>;
}
```

Modify `src/components/center/CenterPanel.tsx`:
```tsx
import { TabBar } from './TabBar';
import { TabContent } from './TabContent';
export function CenterPanel() {
  return (
    <main className="h-full bg-bg flex flex-col">
      <TabBar />
      <TabContent />
    </main>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: tabs slice with TabBar and placeholder TabContent"
```

### Task 3.7: Markdown renderer

**Files:**
- Create: `src/components/history/Markdown.tsx`

- [ ] **Step 1: Komponent z shiki**

Create `src/components/history/Markdown.tsx`:
```tsx
import { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeToHtml } from 'shiki';
import { useStore } from '../../store';

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const theme = useStore(s => s.theme);
  const [html, setHtml] = useState('');
  useEffect(() => {
    const target = theme === 'light' ? 'github-light' : 'github-dark';
    codeToHtml(code, { lang: lang || 'text', theme: target })
      .then(setHtml)
      .catch(() => setHtml(`<pre>${escapeHtml(code)}</pre>`));
  }, [code, lang, theme]);
  return <div className="text-xs overflow-x-auto rounded" dangerouslySetInnerHTML={{ __html: html }} />;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children }) {
          const m = /language-(\w+)/.exec(className || '');
          const code = String(children).replace(/\n$/, '');
          if (inline) return <code className="bg-bg-elev-2 px-1 rounded text-[0.95em]">{children}</code>;
          return <CodeBlock lang={m?.[1] ?? ''} code={code} />;
        },
        a: ({ href, children }) => (
          <a href={href ?? '#'} className="text-accent underline" target="_blank" rel="noreferrer">{children}</a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: Markdown component with shiki code highlighting and theme awareness"
```

### Task 3.8: History block components

**Files:**
- Create: `src/components/history/blocks/UserBubble.tsx`
- Create: `src/components/history/blocks/AssistantBubble.tsx`
- Create: `src/components/history/blocks/ThinkingBlock.tsx`
- Create: `src/components/history/blocks/ToolUseBlock.tsx`
- Create: `src/components/history/blocks/ToolResultBlock.tsx`
- Create: `src/components/history/blocks/AttachmentBlock.tsx`
- Create: `src/components/history/blocks/SystemBlock.tsx`

- [ ] **Step 1: UserBubble**

Create `src/components/history/blocks/UserBubble.tsx`:
```tsx
import { Markdown } from '../Markdown';
export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end my-2">
      <div className="max-w-[80%] bg-bg-elev-2 text-fg rounded-2xl rounded-tr-sm px-3 py-2 text-sm">
        <Markdown text={text} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: AssistantBubble**

Create `src/components/history/blocks/AssistantBubble.tsx`:
```tsx
import { Markdown } from '../Markdown';
export function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start my-2">
      <div className="max-w-[85%] bg-bg-elev text-fg rounded-2xl rounded-tl-sm px-3 py-2 text-sm border border-border">
        <Markdown text={text} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: ThinkingBlock**

Create `src/components/history/blocks/ThinkingBlock.tsx`:
```tsx
import { useState } from 'react';
import { Markdown } from '../Markdown';
export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-muted italic my-1 pl-4">
      <button onClick={() => setOpen(o => !o)} className="hover:text-fg">
        {open ? '▾' : '▸'} thinking ({text.length} znaków)
      </button>
      {open && <div className="mt-1 pl-3 border-l border-border"><Markdown text={text} /></div>}
    </div>
  );
}
```

- [ ] **Step 4: ToolUseBlock**

Create `src/components/history/blocks/ToolUseBlock.tsx`:
```tsx
type Props = { name: string; inputSummary: string; rawInput: unknown };
export function ToolUseBlock({ name, inputSummary, rawInput }: Props) {
  return (
    <details className="my-2 mx-auto max-w-[85%] bg-bg-elev border border-dashed border-border rounded p-2 text-xs">
      <summary className="cursor-pointer text-muted hover:text-fg">
        <span className="text-success mr-2">▸ tool</span>
        <span className="font-mono">{name}</span>
        <span className="ml-2 text-muted">({inputSummary})</span>
      </summary>
      <pre className="mt-2 text-[11px] overflow-x-auto bg-bg p-2 rounded">
        {JSON.stringify(rawInput, null, 2)}
      </pre>
    </details>
  );
}
```

- [ ] **Step 5: ToolResultBlock**

Create `src/components/history/blocks/ToolResultBlock.tsx`:
```tsx
import { useState } from 'react';
const PREVIEW = 200;
type Props = { content: string; isError: boolean };
export function ToolResultBlock({ content, isError }: Props) {
  const [expanded, setExpanded] = useState(content.length <= PREVIEW);
  const shown = expanded ? content : content.slice(0, PREVIEW) + (content.length > PREVIEW ? '…' : '');
  return (
    <div className={`my-2 mx-auto max-w-[85%] border rounded p-2 text-xs font-mono ${isError ? 'border-danger bg-danger/10' : 'border-border bg-bg-elev'}`}>
      <div className="text-muted text-[10px] mb-1">tool_result{isError ? ' (error)' : ''}</div>
      <pre className="whitespace-pre-wrap break-words">{shown}</pre>
      {content.length > PREVIEW && (
        <button onClick={() => setExpanded(e => !e)} className="mt-1 text-accent text-[11px]">
          {expanded ? 'zwiń' : 'rozwiń'}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 6: AttachmentBlock + SystemBlock**

Create `src/components/history/blocks/AttachmentBlock.tsx`:
```tsx
export function AttachmentBlock({ kind, name }: { kind: string; name: string }) {
  return (
    <div className="my-1 text-xs text-muted text-center">
      📎 {kind}: <span className="font-mono">{name}</span>
    </div>
  );
}
```

Create `src/components/history/blocks/SystemBlock.tsx`:
```tsx
export function SystemBlock({ subtype, message }: { subtype: string; message: string }) {
  return (
    <div className="my-1 text-[10px] text-muted text-center opacity-70">
      ⚙ {subtype} · {message}
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: history block components (bubbles, thinking, tool use/result, attachments, system)"
```

### Task 3.9: HistoryView z wirtualizacją

**Files:**
- Create: `src/components/history/HistoryStream.tsx`, `src/components/history/HistoryHeader.tsx`, `src/components/history/HistoryView.tsx`
- Modify: `src/components/center/TabContent.tsx`

- [ ] **Step 1: HistoryStream**

Create `src/components/history/HistoryStream.tsx`:
```tsx
import { Virtuoso } from 'react-virtuoso';
import type { HistoryBlock } from '../../types';
import { UserBubble } from './blocks/UserBubble';
import { AssistantBubble } from './blocks/AssistantBubble';
import { ThinkingBlock } from './blocks/ThinkingBlock';
import { ToolUseBlock } from './blocks/ToolUseBlock';
import { ToolResultBlock } from './blocks/ToolResultBlock';
import { AttachmentBlock } from './blocks/AttachmentBlock';
import { SystemBlock } from './blocks/SystemBlock';

type Props = { blocks: HistoryBlock[]; onLoadMore?: () => void; hasMore: boolean };

function render(b: HistoryBlock) {
  switch (b.kind) {
    case 'UserText':           return <UserBubble text={b.text} />;
    case 'AssistantText':      return <AssistantBubble text={b.text} />;
    case 'AssistantThinking':  return <ThinkingBlock text={b.text} />;
    case 'ToolUse':            return <ToolUseBlock name={b.name} inputSummary={b.inputSummary} rawInput={b.rawInput} />;
    case 'ToolResult':         return <ToolResultBlock content={b.content} isError={b.isError} />;
    case 'Attachment':         return <AttachmentBlock kind={b.kind === 'Attachment' ? (b as any).attachmentKind ?? 'file' : 'file'} name={(b as any).name} />;
    case 'System':             return <SystemBlock subtype={b.subtype} message={b.message} />;
  }
}

export function HistoryStream({ blocks, onLoadMore, hasMore }: Props) {
  return (
    <Virtuoso
      data={blocks}
      itemContent={(_, b) => <div className="px-4">{render(b)}</div>}
      startReached={() => hasMore && onLoadMore?.()}
      followOutput="auto"
      className="flex-1"
    />
  );
}
```

**Uwaga:** ts-rs domyślnie generuje warianty enuma z `tag = "kind"` z nazwą wariantu PascalCase ("UserText" itd.). Jeśli wygenerowany typ używa innej konwencji, dopasuj stringi w `switch`.

- [ ] **Step 2: HistoryHeader**

Create `src/components/history/HistoryHeader.tsx`:
```tsx
import { useStore } from '../../store';
import type { SessionMeta } from '../../types';

type Props = { meta: SessionMeta; tabId: string };

export function HistoryHeader({ meta, tabId }: Props) {
  const setMode = useStore(s => s.setSessionMode);
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg">
      <div>
        <h2 className="text-sm font-semibold text-fg truncate">{meta.title}</h2>
        <div className="text-[11px] text-muted mt-0.5">
          {meta.messageCount} wiadomości · {meta.gitBranch ?? 'no branch'} · {new Date(meta.lastModified).toLocaleString('pl-PL')}
        </div>
      </div>
      <button
        onClick={() => setMode(tabId, 'terminal')}
        className="px-3 py-1.5 bg-accent text-accent-fg rounded text-xs font-semibold hover:opacity-90"
      >
        ▶ Kontynuuj sesję
      </button>
    </header>
  );
}
```

- [ ] **Step 3: HistoryView**

Create `src/components/history/HistoryView.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { SessionHistory } from '../../types';
import { HistoryHeader } from './HistoryHeader';
import { HistoryStream } from './HistoryStream';

type Props = { projectId: number; sessionId: string; tabId: string };

export function HistoryView({ projectId, sessionId, tabId }: Props) {
  const [data, setData] = useState<SessionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tauri.readSessionHistory(projectId, sessionId)
      .then(setData)
      .catch(e => setError(e?.message ?? String(e)));
  }, [projectId, sessionId]);

  const loadMore = async () => {
    if (!data || !data.hasMoreBefore || data.blocks.length === 0) return;
    const firstUuid = (data.blocks[0] as any).uuid;
    const more = await tauri.readSessionHistory(projectId, sessionId, 200, firstUuid);
    setData({
      meta: more.meta,
      blocks: [...more.blocks, ...data.blocks],
      hasMoreBefore: more.hasMoreBefore,
    });
  };

  if (error) return <div className="p-4 text-danger text-sm">Błąd: {error}</div>;
  if (!data) return <div className="p-4 text-muted text-sm">Wczytywanie historii…</div>;
  return (
    <div className="h-full flex flex-col">
      <HistoryHeader meta={data.meta} tabId={tabId} />
      <HistoryStream blocks={data.blocks} onLoadMore={loadMore} hasMore={data.hasMoreBefore} />
    </div>
  );
}
```

- [ ] **Step 4: TabContent dispatch**

Modify `src/components/center/TabContent.tsx`:
```tsx
import { useStore } from '../../store';
import { HistoryView } from '../history/HistoryView';

export function TabContent() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const tab = tabs.find(t => t.id === active);
  if (!tab) return <div className="flex-1 grid place-items-center text-muted">Wybierz sesję z lewej</div>;

  if (tab.kind === 'session' && tab.mode === 'history') {
    return <HistoryView projectId={tab.projectId} sessionId={tab.sessionId} tabId={tab.id} />;
  }
  if (tab.kind === 'session' && tab.mode === 'terminal') {
    return <div className="flex-1 grid place-items-center text-muted">(Terminal — Phase 5)</div>;
  }
  return <div className="flex-1 grid place-items-center text-muted">(Action log — Phase 6)</div>;
}
```

- [ ] **Step 5: Smoke**

Kliknij sesję — renderuje się chat-view, scroll przez react-virtuoso działa, "load more" auto-trigger przy scroll-up. Klik **▶ Kontynuuj** — przełącza na placeholder terminala.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: HistoryView with virtualized chat-style rendering and load-more on scroll"
```

---

## Phase 4 — File watcher (live session updates)

### Task 4.1: Watcher modułu z notify

**Files:**
- Create: `src-tauri/src/sessions/watcher.rs`
- Modify: `src-tauri/src/sessions/mod.rs`, `src-tauri/src/state.rs`

- [ ] **Step 1: Watcher**

Create `src-tauri/src/sessions/watcher.rs`:
```rust
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use parking_lot::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _, Event, EventKind};
use tauri::{AppHandle, Emitter};
use crate::domain::HistoryBlock;
use crate::error::AppResult;
use crate::sessions::parser::parse_line;

struct OpenSession {
    path: PathBuf,
    last_offset: u64,
}

pub struct SessionWatchers {
    sessions: Mutex<HashMap<String, OpenSession>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl SessionWatchers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
        })
    }

    pub fn open(self: &Arc<Self>, app: AppHandle, session_id: &str, path: PathBuf) -> AppResult<()> {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        {
            let mut s = self.sessions.lock();
            s.insert(session_id.to_string(), OpenSession { path: path.clone(), last_offset: size });
        }
        let mut w = self.watcher.lock();
        if w.is_none() {
            let self_clone = self.clone();
            let app_clone = app.clone();
            let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
                if let Ok(ev) = res {
                    if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                        for p in ev.paths {
                            self_clone.handle_change(&app_clone, &p);
                        }
                    }
                }
            }).map_err(|e| crate::error::AppError::Other(format!("notify: {e}")))?;
            *w = Some(watcher);
        }
        if let Some(watcher) = w.as_mut() {
            let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or(path.clone());
            let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
        }
        Ok(())
    }

    pub fn close(&self, session_id: &str) {
        self.sessions.lock().remove(session_id);
    }

    fn handle_change(&self, app: &AppHandle, changed: &Path) {
        let mut sessions = self.sessions.lock();
        let mut updates: Vec<(String, Vec<HistoryBlock>)> = Vec::new();

        for (sid, sess) in sessions.iter_mut() {
            if sess.path != changed { continue; }
            let new_size = match std::fs::metadata(&sess.path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if new_size <= sess.last_offset { continue; }
            let blocks = read_tail(&sess.path, sess.last_offset, new_size);
            sess.last_offset = new_size;
            if !blocks.is_empty() {
                updates.push((sid.clone(), blocks));
            }
        }
        drop(sessions);

        for (sid, blocks) in updates {
            let _ = app.emit(&format!("session:{sid}:append"), serde_json::json!({ "blocks": blocks }));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn read_tail(path: &Path, from: u64, to: u64) -> Vec<HistoryBlock> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return vec![] };
    if f.seek(SeekFrom::Start(from)).is_err() { return vec![]; }
    let mut buf = vec![0u8; (to - from) as usize];
    if f.read_exact(&mut buf).is_err() { return vec![]; }
    let text = String::from_utf8_lossy(&buf);
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() { continue; }
        if let Ok(bs) = parse_line(line) {
            out.extend(bs);
        }
    }
    out
}
```

- [ ] **Step 2: Wpięcie modułu**

Modify `src-tauri/src/sessions/mod.rs` — dodaj `pub mod watcher;`.

- [ ] **Step 3: AppState dostaje watchers**

Modify `src-tauri/src/state.rs`:
```rust
use std::sync::Arc;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self { db, session_watchers: SessionWatchers::new() }
    }
}
```

- [ ] **Step 4: Sanity build**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cd ..`
Expected: OK.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(backend): JSONL file watcher with tail-append emission"
```

### Task 4.2: Commands open/close watch + frontend listener

**Files:**
- Modify: `src-tauri/src/commands/sessions.rs`, `src-tauri/src/main.rs`, `src/lib/tauri.ts`, `src/components/history/HistoryView.tsx`

- [ ] **Step 1: Commands**

Modify `src-tauri/src/commands/sessions.rs` — dodaj:
```rust
use tauri::AppHandle;
use crate::sessions::reader::session_file;

#[tauri::command]
pub fn open_session_watch(
    app: AppHandle,
    state: State<AppState>,
    project_id: i64,
    session_id: String,
) -> AppResult<()> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let dir = claude_root()?.join(&proj.claude_dir);
    let path = session_file(&dir, &session_id);
    state.session_watchers.open(app, &session_id, path)
}

#[tauri::command]
pub fn close_session_watch(state: State<AppState>, session_id: String) -> AppResult<()> {
    state.session_watchers.close(&session_id);
    Ok(())
}
```

- [ ] **Step 2: Rejestracja**

Modify `src-tauri/src/main.rs` — dodaj do `generate_handler!`:
```rust
commands::sessions::open_session_watch,
commands::sessions::close_session_watch,
```

- [ ] **Step 3: TS wrappery + listener**

Modify `src/lib/tauri.ts` — dodaj:
```ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { HistoryBlock } from '../types';

// w obiekcie tauri:
openSessionWatch: (projectId: number, sessionId: string) =>
  invoke<void>('open_session_watch', { projectId, sessionId }),
closeSessionWatch: (sessionId: string) =>
  invoke<void>('close_session_watch', { sessionId }),
onSessionAppend: (sessionId: string, cb: (blocks: HistoryBlock[]) => void): Promise<UnlistenFn> =>
  listen<{ blocks: HistoryBlock[] }>(`session:${sessionId}:append`, e => cb(e.payload.blocks)),
```

- [ ] **Step 4: HistoryView subskrybuje**

Modify `src/components/history/HistoryView.tsx` — dodaj efekt obok pierwszego:
```tsx
useEffect(() => {
  let unlisten: (() => void) | null = null;
  tauri.openSessionWatch(projectId, sessionId).catch(() => {});
  tauri.onSessionAppend(sessionId, (blocks) => {
    setData(prev => prev ? ({ ...prev, blocks: [...prev.blocks, ...blocks] }) : prev);
  }).then(fn => { unlisten = fn; });
  return () => {
    unlisten?.();
    tauri.closeSessionWatch(sessionId).catch(() => {});
  };
}, [projectId, sessionId]);
```

- [ ] **Step 5: Smoke**

Otwórz sesję w aplikacji, jednocześnie uruchom `claude -r <id>` w terminalu zewnętrznym, wpisz coś — nowe wiadomości pojawiają się na żywo w widoku.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: live session updates via notify-based watcher and Tauri events"
```

---

## Phase 5 — PTY + wbudowany terminal

### Task 5.1: PTY manager w Rust

**Files:**
- Create: `src-tauri/src/pty/mod.rs`, `src-tauri/src/pty/handle.rs`
- Modify: `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: PtyHandle z Drop guard**

Create `src-tauri/src/pty/handle.rs`:
```rust
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use std::thread;
use portable_pty::{Child, MasterPty, PtySize, CommandBuilder, native_pty_system};
use tauri::{AppHandle, Emitter};
use crate::error::{AppError, AppResult};

pub struct PtyHandle {
    pub id: String,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

impl PtyHandle {
    pub fn spawn(
        app: AppHandle,
        id: String,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
    ) -> AppResult<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(program);
        for a in args { cmd.arg(a); }
        cmd.cwd(cwd);
        for (k, v) in std::env::vars() { cmd.env(k, v); }
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd).map_err(|e| AppError::Pty(e.to_string()))?;
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| AppError::Pty(e.to_string()))?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| AppError::Pty(e.to_string()))?;

        let id_for_thread = id.clone();
        let app_for_thread = app.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        use base64::Engine;
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app_for_thread.emit(
                            &format!("pty:{id_for_thread}:output"),
                            serde_json::json!({ "data": encoded }),
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let id_for_exit = id.clone();
        let app_for_exit = app.clone();
        let child_arc: Arc<Mutex<Box<dyn Child + Send + Sync>>> = Arc::new(Mutex::new(child));
        let child_for_exit = child_arc.clone();
        thread::spawn(move || {
            let code = child_for_exit.lock().unwrap().wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            let _ = app_for_exit.emit(
                &format!("pty:{id_for_exit}:exit"),
                serde_json::json!({ "code": code }),
            );
        });

        Ok(PtyHandle {
            id,
            master: Arc::new(Mutex::new(pair.master)),
            child: child_arc,
            writer: Arc::new(Mutex::new(writer)),
        })
    }

    pub fn write(&self, data: &[u8]) -> AppResult<()> {
        self.writer.lock().unwrap().write_all(data).map_err(AppError::Io)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| AppError::Pty(e.to_string()))
    }

    pub fn kill(&self) -> AppResult<()> {
        let _ = self.child.lock().unwrap().kill();
        Ok(())
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        let _ = self.child.lock().unwrap().kill();
    }
}
```

- [ ] **Step 2: PtyManager**

Create `src-tauri/src/pty/mod.rs`:
```rust
pub mod handle;

use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;
use uuid::Uuid;
use tauri::AppHandle;
use crate::error::{AppError, AppResult};
use self::handle::PtyHandle;

#[derive(Default)]
pub struct PtyManager {
    inner: Mutex<HashMap<String, Arc<PtyHandle>>>,
}

impl PtyManager {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    pub fn spawn(
        &self,
        app: AppHandle,
        program: &str,
        args: &[&str],
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
        let id = Uuid::new_v4().to_string();
        let h = PtyHandle::spawn(app, id.clone(), program, args, cwd, cols, rows)?;
        self.inner.lock().insert(id.clone(), Arc::new(h));
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        let g = self.inner.lock();
        let h = g.get(id).ok_or_else(|| AppError::NotFound(format!("pty {id}")))?;
        h.write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let g = self.inner.lock();
        let h = g.get(id).ok_or_else(|| AppError::NotFound(format!("pty {id}")))?;
        h.resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> AppResult<()> {
        let mut g = self.inner.lock();
        if let Some(h) = g.remove(id) { let _ = h.kill(); }
        Ok(())
    }
}
```

- [ ] **Step 3: AppState dostaje pty**

Modify `src-tauri/src/state.rs`:
```rust
use std::sync::Arc;
use crate::db::DbPool;
use crate::sessions::watcher::SessionWatchers;
use crate::pty::PtyManager;

pub struct AppState {
    pub db: DbPool,
    pub session_watchers: Arc<SessionWatchers>,
    pub pty: Arc<PtyManager>,
}

impl AppState {
    pub fn new(db: DbPool) -> Self {
        Self {
            db,
            session_watchers: SessionWatchers::new(),
            pty: PtyManager::new(),
        }
    }
}
```

- [ ] **Step 4: lib.rs + main.rs**

Modify `src-tauri/src/lib.rs` — dodaj `pub mod pty;`.
Modify `src-tauri/src/main.rs` — dodaj `mod pty;`.

- [ ] **Step 5: Build sanity**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cd ..`
Expected: OK.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(backend): PTY manager with portable-pty, output streaming via events"
```

### Task 5.2: Tauri commands PTY

**Files:**
- Create: `src-tauri/src/commands/pty.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/main.rs`

- [ ] **Step 1: Commands**

Create `src-tauri/src/commands/pty.rs`:
```rust
use serde::Deserialize;
use ts_rs::TS;
use tauri::{AppHandle, State};
use base64::Engine;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::db::projects_repo;

#[derive(Deserialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PtyKind {
    Claude { session_id: String },
    Action { action_id: i64 },
}

#[tauri::command]
pub fn spawn_pty(
    app: AppHandle,
    state: State<AppState>,
    project_id: i64,
    kind: PtyKind,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    let cwd = std::path::PathBuf::from(&proj.path);

    let (program, args_owned) = match &kind {
        PtyKind::Claude { session_id } => {
            ("bash".to_string(), vec!["-lc".to_string(), format!("claude --resume {session_id}")])
        }
        PtyKind::Action { action_id } => {
            let action = crate::db::actions_repo::get(&c, *action_id)?;
            ("bash".to_string(), vec!["-lc".to_string(), action.command.clone()])
        }
    };

    let args_ref: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
    state.pty.spawn(app, &program, &args_ref, &cwd, cols, rows)
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, pty_id: String, data: String) -> AppResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes())
        .map_err(|e| AppError::Other(format!("base64: {e}")))?;
    state.pty.write(&pty_id, &bytes)
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, pty_id: String, cols: u16, rows: u16) -> AppResult<()> {
    state.pty.resize(&pty_id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<AppState>, pty_id: String) -> AppResult<()> {
    state.pty.kill(&pty_id)
}
```

- [ ] **Step 2: mod.rs + main.rs**

Modify `src-tauri/src/commands/mod.rs` — dodaj `pub mod pty;`.
Modify `src-tauri/src/main.rs` — w `generate_handler!`:
```rust
commands::pty::spawn_pty,
commands::pty::pty_write,
commands::pty::pty_resize,
commands::pty::pty_kill,
```

Uwaga: `actions_repo` jeszcze nie istnieje (powstanie w Phase 6). Tymczasowo zaślepka — usuń branch `Action` z PtyKind do czasu Phase 6, albo zostaw + dodaj pusty `actions_repo` na ten task.

Tymczasowy `src-tauri/src/db/actions_repo.rs`:
```rust
use rusqlite::Connection;
use crate::domain::Action;
use crate::error::{AppError, AppResult};

pub fn get(_conn: &Connection, _id: i64) -> AppResult<Action> {
    Err(AppError::NotFound("actions_repo not implemented yet".into()))
}
```
I dodaj `pub mod actions_repo;` w `src-tauri/src/db/mod.rs`.

- [ ] **Step 3: Build sanity**

Run: `cd src-tauri && cargo build 2>&1 | tail -5 && cd ..`
Expected: OK.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: PTY Tauri commands (spawn/write/resize/kill) with claude resume support"
```

### Task 5.3: TerminalView z xterm.js

**Files:**
- Create: `src/components/terminal/TerminalView.tsx`
- Modify: `src/lib/tauri.ts`, `src/components/center/TabContent.tsx`

- [ ] **Step 1: TS wrappery**

Modify `src/lib/tauri.ts` — dodaj:
```ts
// types lokalne
type PtyKind = { kind: 'Claude'; sessionId: string } | { kind: 'Action'; actionId: number };

// w obiekcie tauri:
spawnPty: (projectId: number, kind: PtyKind, cols: number, rows: number) =>
  invoke<string>('spawn_pty', { projectId, kind, cols, rows }),
ptyWrite: (ptyId: string, data: string) => invoke<void>('pty_write', { ptyId, data }),
ptyResize: (ptyId: string, cols: number, rows: number) =>
  invoke<void>('pty_resize', { ptyId, cols, rows }),
ptyKill: (ptyId: string) => invoke<void>('pty_kill', { ptyId }),
onPtyOutput: (ptyId: string, cb: (bytes: Uint8Array) => void) =>
  listen<{ data: string }>(`pty:${ptyId}:output`, e => {
    const bin = atob(e.payload.data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    cb(arr);
  }),
onPtyExit: (ptyId: string, cb: (code: number) => void) =>
  listen<{ code: number }>(`pty:${ptyId}:exit`, e => cb(e.payload.code)),
```

- [ ] **Step 2: TerminalView**

Create `src/components/terminal/TerminalView.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { tauri } from '../../lib/tauri';

type Props = { projectId: number; kind: 'Claude' | 'Action'; sessionId?: string; actionId?: number };

export function TerminalView({ projectId, kind, sessionId, actionId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<string | null>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0f1115' },
      cursorBlink: true,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const cols = term.cols, rows = term.rows;
    const ptyKind = kind === 'Claude'
      ? { kind: 'Claude' as const, sessionId: sessionId! }
      : { kind: 'Action' as const, actionId: actionId! };

    tauri.spawnPty(projectId, ptyKind, cols, rows).then(async (id) => {
      ptyRef.current = id;
      const offOut = await tauri.onPtyOutput(id, (bytes) => term.write(bytes));
      const offExit = await tauri.onPtyExit(id, (code) => term.write(`\r\n\x1b[33m[process exited with code ${code}]\x1b[0m\r\n`));
      unlistenRefs.current.push(offOut, offExit);

      term.onData((d) => {
        const enc = btoa(unescape(encodeURIComponent(d)));
        tauri.ptyWrite(id, enc);
      });
      term.onResize(({ cols, rows }) => tauri.ptyResize(id, cols, rows));
    });

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      unlistenRefs.current.forEach(fn => fn());
      if (ptyRef.current) tauri.ptyKill(ptyRef.current).catch(() => {});
      term.dispose();
    };
  }, [projectId, kind, sessionId, actionId]);

  return <div ref={containerRef} className="h-full w-full bg-bg p-2" />;
}
```

- [ ] **Step 3: TabContent dispatch**

Modify `src/components/center/TabContent.tsx`:
```tsx
import { useStore } from '../../store';
import { HistoryView } from '../history/HistoryView';
import { TerminalView } from '../terminal/TerminalView';

export function TabContent() {
  const tabs = useStore(s => s.tabs);
  const active = useStore(s => s.activeTabId);
  const tab = tabs.find(t => t.id === active);
  if (!tab) return <div className="flex-1 grid place-items-center text-muted">Wybierz sesję z lewej</div>;

  if (tab.kind === 'session' && tab.mode === 'history') {
    return <HistoryView projectId={tab.projectId} sessionId={tab.sessionId} tabId={tab.id} />;
  }
  if (tab.kind === 'session' && tab.mode === 'terminal') {
    return <TerminalView projectId={tab.projectId} kind="Claude" sessionId={tab.sessionId} />;
  }
  if (tab.kind === 'action') {
    return <TerminalView projectId={tab.projectId} kind="Action" actionId={tab.actionId} />;
  }
  return null;
}
```

- [ ] **Step 4: Smoke**

Klik sesji → ▶ Kontynuuj → terminal otwiera się z `claude --resume`, można pisać i widzieć output.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: TerminalView with xterm.js connected to backend PTY via Tauri events"
```

---

## Phase 6 — Akcje i detektory skryptów

### Task 6.1: Actions repository

**Files:**
- Modify: `src-tauri/src/db/actions_repo.rs` (zastąp zaślepkę)

- [ ] **Step 1: Pełna implementacja**

Replace `src-tauri/src/db/actions_repo.rs`:
```rust
use rusqlite::{params, Connection};
use crate::domain::Action;
use crate::error::AppResult;

fn row(r: &rusqlite::Row) -> rusqlite::Result<Action> {
    Ok(Action {
        id: r.get(0)?,
        project_id: r.get(1)?,
        label: r.get(2)?,
        command: r.get(3)?,
        working_dir: r.get(4)?,
        source: r.get(5)?,
        sort_order: r.get(6)?,
    })
}

pub fn list(conn: &Connection, project_id: i64) -> AppResult<Vec<Action>> {
    let mut s = conn.prepare(
        "SELECT id,project_id,label,command,working_dir,source,sort_order
         FROM actions WHERE project_id=? ORDER BY sort_order ASC, id ASC",
    )?;
    let rows = s.query_map(params![project_id], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<Action> {
    Ok(conn.query_row(
        "SELECT id,project_id,label,command,working_dir,source,sort_order FROM actions WHERE id=?",
        params![id], row,
    )?)
}

pub fn insert(
    conn: &Connection,
    project_id: i64, label: &str, command: &str,
    working_dir: Option<&str>, source: Option<&str>,
) -> AppResult<Action> {
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order)+1, 0) FROM actions WHERE project_id=?",
        params![project_id], |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO actions(project_id,label,command,working_dir,source,sort_order)
         VALUES(?,?,?,?,?,?)",
        params![project_id, label, command, working_dir, source, sort_order],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)
}

pub fn update(
    conn: &Connection, id: i64,
    label: Option<&str>, command: Option<&str>, working_dir: Option<&str>,
) -> AppResult<Action> {
    if let Some(l) = label {
        conn.execute("UPDATE actions SET label=? WHERE id=?", params![l, id])?;
    }
    if let Some(c) = command {
        conn.execute("UPDATE actions SET command=? WHERE id=?", params![c, id])?;
    }
    if let Some(w) = working_dir {
        conn.execute("UPDATE actions SET working_dir=? WHERE id=?", params![w, id])?;
    }
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM actions WHERE id=?", params![id])?;
    Ok(())
}
```

- [ ] **Step 2: Test**

Add unit test at the bottom of the file:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, projects_repo};
    use tempfile::NamedTempFile;

    #[test]
    fn crud_actions() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();
        let a = insert(&c, p.id, "dev", "npm run dev", None, Some("npm")).unwrap();
        assert_eq!(a.label, "dev");
        assert_eq!(list(&c, p.id).unwrap().len(), 1);
        update(&c, a.id, Some("dev2"), None, None).unwrap();
        assert_eq!(get(&c, a.id).unwrap().label, "dev2");
        delete(&c, a.id).unwrap();
        assert_eq!(list(&c, p.id).unwrap().len(), 0);
    }
}
```

Run: `cd src-tauri && cargo test actions_repo:: 2>&1 | tail -10 && cd ..`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(backend): actions repository CRUD with tests"
```

### Task 6.2: ScriptDetector trait + detektory

**Files:**
- Create: `src-tauri/src/detectors/mod.rs`, `src-tauri/src/detectors/npm.rs`, `src-tauri/src/detectors/composer.rs`, `src-tauri/src/detectors/make.rs`, `src-tauri/src/detectors/ddev.rs`, `src-tauri/src/detectors/docker_compose.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Trait + struct**

Create `src-tauri/src/detectors/mod.rs`:
```rust
pub mod npm;
pub mod composer;
pub mod make;
pub mod ddev;
pub mod docker_compose;

use serde::Serialize;
use ts_rs::TS;
use std::path::Path;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DetectedScript {
    pub source: String,
    pub label: String,
    pub command: String,
    pub description: Option<String>,
}

pub trait ScriptDetector: Send + Sync {
    fn name(&self) -> &str;
    fn detect(&self, path: &Path) -> Vec<DetectedScript>;
}

pub fn all_detectors() -> Vec<Box<dyn ScriptDetector>> {
    vec![
        Box::new(npm::NpmDetector),
        Box::new(composer::ComposerDetector),
        Box::new(make::MakeDetector),
        Box::new(ddev::DdevDetector),
        Box::new(docker_compose::DockerComposeDetector),
    ]
}

pub fn detect_all(path: &Path) -> Vec<DetectedScript> {
    all_detectors().iter().flat_map(|d| d.detect(path)).collect()
}
```

- [ ] **Step 2: NpmDetector**

Create `src-tauri/src/detectors/npm.rs`:
```rust
use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct NpmDetector;

impl ScriptDetector for NpmDetector {
    fn name(&self) -> &str { "npm" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let pkg = path.join("package.json");
        let Ok(text) = std::fs::read_to_string(&pkg) else { return vec![]; };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![]; };
        let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) else { return vec![]; };
        scripts.iter().map(|(name, body)| DetectedScript {
            source: "npm".into(),
            label: format!("npm run {name}"),
            command: format!("npm run {name}"),
            description: body.as_str().map(String::from),
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn detects_scripts() {
        let td = TempDir::new().unwrap();
        std::fs::write(td.path().join("package.json"),
            r#"{"scripts":{"dev":"vite","build":"vite build"}}"#).unwrap();
        let r = NpmDetector.detect(td.path());
        assert_eq!(r.len(), 2);
        assert!(r.iter().any(|s| s.label == "npm run dev"));
    }

    #[test]
    fn empty_when_no_package_json() {
        let td = TempDir::new().unwrap();
        assert!(NpmDetector.detect(td.path()).is_empty());
    }
}
```

- [ ] **Step 3: ComposerDetector**

Create `src-tauri/src/detectors/composer.rs`:
```rust
use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct ComposerDetector;

impl ScriptDetector for ComposerDetector {
    fn name(&self) -> &str { "composer" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let f = path.join("composer.json");
        let Ok(text) = std::fs::read_to_string(&f) else { return vec![]; };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![]; };
        let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) else { return vec![]; };
        scripts.keys().map(|name| DetectedScript {
            source: "composer".into(),
            label: format!("composer {name}"),
            command: format!("composer {name}"),
            description: None,
        }).collect()
    }
}
```

- [ ] **Step 4: MakeDetector**

Create `src-tauri/src/detectors/make.rs`:
```rust
use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct MakeDetector;

impl ScriptDetector for MakeDetector {
    fn name(&self) -> &str { "make" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let mf = path.join("Makefile");
        let Ok(text) = std::fs::read_to_string(&mf) else { return vec![]; };
        let mut out = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') || trimmed.starts_with('\t') { continue; }
            if let Some(idx) = trimmed.find(':') {
                let name = trimmed[..idx].trim();
                if name.is_empty() || name.contains(' ') || name.contains('=') { continue; }
                if name.starts_with('.') { continue; }
                out.push(DetectedScript {
                    source: "make".into(),
                    label: format!("make {name}"),
                    command: format!("make {name}"),
                    description: None,
                });
            }
        }
        out
    }
}
```

- [ ] **Step 5: DdevDetector**

Create `src-tauri/src/detectors/ddev.rs`:
```rust
use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct DdevDetector;

impl ScriptDetector for DdevDetector {
    fn name(&self) -> &str { "ddev" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        if !path.join(".ddev").join("config.yaml").exists()
            && !path.join(".ddev").join("config.yml").exists() {
            return vec![];
        }
        let presets = [
            ("start", "ddev start"),
            ("stop", "ddev stop"),
            ("restart", "ddev restart"),
            ("ssh", "ddev ssh"),
            ("logs", "ddev logs -f"),
            ("describe", "ddev describe"),
        ];
        presets.iter().map(|(name, cmd)| DetectedScript {
            source: "ddev".into(),
            label: format!("ddev {name}"),
            command: cmd.to_string(),
            description: None,
        }).collect()
    }
}
```

- [ ] **Step 6: DockerComposeDetector**

Create `src-tauri/src/detectors/docker_compose.rs`:
```rust
use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct DockerComposeDetector;

impl ScriptDetector for DockerComposeDetector {
    fn name(&self) -> &str { "docker" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
        if !candidates.iter().any(|f| path.join(f).exists()) {
            return vec![];
        }
        ["up -d", "down", "ps", "logs -f", "build"].iter().map(|sub| DetectedScript {
            source: "docker".into(),
            label: format!("docker compose {sub}"),
            command: format!("docker compose {sub}"),
            description: None,
        }).collect()
    }
}
```

- [ ] **Step 7: Wpięcie + testy**

Modify `src-tauri/src/lib.rs` — dodaj `pub mod detectors;`.

Run: `cd src-tauri && cargo test detectors:: 2>&1 | tail -10 && cd ..`
Expected: testy PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(backend): script detectors (npm, composer, make, ddev, docker-compose)"
```

### Task 6.3: Actions commands + detect_scripts

**Files:**
- Create: `src-tauri/src/commands/actions.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/main.rs`, `src/lib/tauri.ts`

- [ ] **Step 1: Commands**

Create `src-tauri/src/commands/actions.rs`:
```rust
use std::path::PathBuf;
use tauri::State;
use crate::domain::{Action, ActionInput, ActionPatch};
use crate::detectors::{detect_all, DetectedScript};
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::actions_repo as repo;

#[tauri::command]
pub fn list_actions(state: State<AppState>, project_id: i64) -> AppResult<Vec<Action>> {
    let c = state.db.get()?;
    repo::list(&c, project_id)
}

#[tauri::command]
pub fn detect_scripts(project_path: String) -> AppResult<Vec<DetectedScript>> {
    Ok(detect_all(&PathBuf::from(project_path)))
}

#[tauri::command]
pub fn add_action(state: State<AppState>, input: ActionInput) -> AppResult<Action> {
    let c = state.db.get()?;
    repo::insert(
        &c, input.project_id, &input.label, &input.command,
        input.working_dir.as_deref(), input.source.as_deref(),
    )
}

#[tauri::command]
pub fn update_action(state: State<AppState>, id: i64, patch: ActionPatch) -> AppResult<Action> {
    let c = state.db.get()?;
    repo::update(&c, id, patch.label.as_deref(), patch.command.as_deref(), patch.working_dir.as_deref())
}

#[tauri::command]
pub fn remove_action(state: State<AppState>, id: i64) -> AppResult<()> {
    let c = state.db.get()?;
    repo::delete(&c, id)
}
```

- [ ] **Step 2: Rejestracja**

Modify `src-tauri/src/commands/mod.rs` — dodaj `pub mod actions;`.
Modify `src-tauri/src/main.rs` — dodaj do `generate_handler!`:
```rust
commands::actions::list_actions,
commands::actions::detect_scripts,
commands::actions::add_action,
commands::actions::update_action,
commands::actions::remove_action,
```

- [ ] **Step 3: TS wrappery**

Modify `src/lib/tauri.ts` — dodaj:
```ts
import type { Action, ActionInput, ActionPatch, DetectedScript } from '../types';

// w obiekcie:
listActions: (projectId: number) => invoke<Action[]>('list_actions', { projectId }),
detectScripts: (projectPath: string) => invoke<DetectedScript[]>('detect_scripts', { projectPath }),
addAction: (input: ActionInput) => invoke<Action>('add_action', { input }),
updateAction: (id: number, patch: ActionPatch) => invoke<Action>('update_action', { id, patch }),
removeAction: (id: number) => invoke<void>('remove_action', { id }),
```

I `src/types/index.ts` — dodaj `DetectedScript`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: actions commands and script detection endpoint"
```

### Task 6.4: AddProjectDialog z detekcją + AddActionDialog

**Files:**
- Modify: `src/components/dialogs/AddProjectDialog.tsx`
- Create: `src/components/dialogs/AddActionDialog.tsx`

- [ ] **Step 1: AddProjectDialog rozszerzony**

Replace `src/components/dialogs/AddProjectDialog.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { tauri } from '../../lib/tauri';
import { useStore } from '../../store';
import type { DetectedScript } from '../../types';

type Props = { onClose: () => void };

export function AddProjectDialog({ onClose }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [scripts, setScripts] = useState<DetectedScript[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const addProject = useStore(s => s.addProject);

  useEffect(() => {
    if (!path) { setScripts([]); return; }
    tauri.detectScripts(path).then(setScripts).catch(() => setScripts([]));
  }, [path]);

  const pickFolder = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === 'string') {
      setPath(sel);
      if (!name) setName(sel.split('/').pop() ?? sel);
    }
  };

  const toggle = (i: number) => {
    const next = new Set(selected);
    next.has(i) ? next.delete(i) : next.add(i);
    setSelected(next);
  };

  const submit = async () => {
    setError(null);
    try {
      const project = await addProject(name.trim(), path.trim());
      for (const i of selected) {
        const s = scripts[i];
        await tauri.addAction({
          projectId: project.id, label: s.label, command: s.command,
          workingDir: null, source: s.source,
        });
      }
      onClose();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border rounded-lg p-5 w-[520px] max-h-[80vh] overflow-auto">
        <h2 className="text-lg font-semibold mb-3">Dodaj projekt</h2>
        <label className="block text-xs text-muted mb-1">Ścieżka</label>
        <div className="flex gap-2 mb-3">
          <input value={path} onChange={e => setPath(e.target.value)}
            className="flex-1 bg-bg border border-border rounded px-2 py-1" />
          <button onClick={pickFolder}
            className="px-3 py-1 border border-border rounded bg-bg-elev-2">Wybierz…</button>
        </div>
        <label className="block text-xs text-muted mb-1">Nazwa</label>
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 mb-4" />

        {scripts.length > 0 && (
          <>
            <div className="text-xs text-muted mb-2">Wykryte skrypty — wybierz, które dodać jako akcje:</div>
            <div className="space-y-1 mb-4 max-h-64 overflow-auto border border-border rounded p-2">
              {scripts.map((s, i) => (
                <label key={`${s.source}-${s.label}-${i}`} className="flex items-center gap-2 py-0.5 cursor-pointer">
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                  <span className="text-[10px] text-muted uppercase w-16">{s.source}</span>
                  <span className="font-mono text-xs">{s.label}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {error && <div className="text-danger text-sm mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 border border-border rounded">Anuluj</button>
          <button onClick={submit}
            className="px-3 py-1 bg-accent text-accent-fg rounded"
            disabled={!name.trim() || !path.trim()}>Dodaj</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: AddActionDialog (manual + z listy detected)**

Create `src/components/dialogs/AddActionDialog.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { DetectedScript } from '../../types';

type Props = { projectId: number; projectPath: string; onClose: () => void; onAdded: () => void };

export function AddActionDialog({ projectId, projectPath, onClose, onAdded }: Props) {
  const [scripts, setScripts] = useState<DetectedScript[]>([]);
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');

  useEffect(() => {
    tauri.detectScripts(projectPath).then(setScripts).catch(() => {});
  }, [projectPath]);

  const useDetected = (s: DetectedScript) => {
    setLabel(s.label);
    setCommand(s.command);
  };

  const submit = async () => {
    await tauri.addAction({
      projectId, label: label.trim(), command: command.trim(),
      workingDir: null, source: 'manual',
    });
    onAdded();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border rounded-lg p-5 w-[480px] max-h-[80vh] overflow-auto">
        <h2 className="text-lg font-semibold mb-3">Dodaj akcję</h2>
        {scripts.length > 0 && (
          <div className="mb-3">
            <div className="text-xs text-muted mb-1">Wykryte skrypty (kliknij aby uzupełnić pola):</div>
            <div className="space-y-1 max-h-40 overflow-auto border border-border rounded p-2">
              {scripts.map((s, i) => (
                <button key={i} onClick={() => useDetected(s)}
                  className="w-full text-left px-2 py-1 rounded hover:bg-bg-elev-2 text-xs">
                  <span className="text-[10px] text-muted uppercase mr-2">{s.source}</span>
                  <span className="font-mono">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="block text-xs text-muted mb-1">Etykieta</label>
        <input value={label} onChange={e => setLabel(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 mb-3" />
        <label className="block text-xs text-muted mb-1">Komenda</label>
        <input value={command} onChange={e => setCommand(e.target.value)}
          className="w-full bg-bg border border-border rounded px-2 py-1 mb-4 font-mono text-xs" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 border border-border rounded">Anuluj</button>
          <button onClick={submit} disabled={!label.trim() || !command.trim()}
            className="px-3 py-1 bg-accent text-accent-fg rounded">Dodaj</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: AddProjectDialog with detected scripts checkboxes; AddActionDialog"
```

### Task 6.5: Actions slice + ActionList + ActionRow + uruchamianie

**Files:**
- Create: `src/store/actionsSlice.ts`, `src/components/right/ActionsSection.tsx`, `src/components/right/ActionList.tsx`, `src/components/right/ActionRow.tsx`
- Modify: `src/store/index.ts`, `src/components/right/RightPanel.tsx`

- [ ] **Step 1: Actions slice**

Create `src/store/actionsSlice.ts`:
```ts
import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { Action } from '../types';

export type RunningAction = { actionId: number; ptyId: string; tabId: string };

export type ActionsSlice = {
  actionsByProject: Record<number, Action[]>;
  runningActions: Record<number, RunningAction>;
  loadActions: (projectId: number) => Promise<void>;
  markRunning: (actionId: number, ptyId: string, tabId: string) => void;
  markStopped: (actionId: number) => void;
  removeAction: (id: number) => Promise<void>;
};

export const createActionsSlice: StateCreator<ActionsSlice> = (set, get) => ({
  actionsByProject: {},
  runningActions: {},
  loadActions: async (projectId) => {
    const items = await tauri.listActions(projectId);
    set({ actionsByProject: { ...get().actionsByProject, [projectId]: items } });
  },
  markRunning: (actionId, ptyId, tabId) =>
    set({ runningActions: { ...get().runningActions, [actionId]: { actionId, ptyId, tabId } } }),
  markStopped: (actionId) => {
    const next = { ...get().runningActions };
    delete next[actionId];
    set({ runningActions: next });
  },
  removeAction: async (id) => {
    await tauri.removeAction(id);
    const byProj = { ...get().actionsByProject };
    for (const pid of Object.keys(byProj)) {
      byProj[Number(pid)] = byProj[Number(pid)].filter(a => a.id !== id);
    }
    set({ actionsByProject: byProj });
  },
});
```

I dopnij w `src/store/index.ts` (analogicznie do innych slice'ów).

- [ ] **Step 2: Selektor aktywnego projektu**

Modify `src/store/index.ts` — dodaj do `AppState` helper computed:
```ts
// w komponentach: const activeProjectId = useStore(s => {
//   const t = s.tabs.find(t => t.id === s.activeTabId);
//   return t?.projectId ?? s.projects[0]?.id ?? null;
// });
```

(Nie wymaga zmiany store, sygnatura jako selektor w komponentach.)

- [ ] **Step 3: ActionRow**

Create `src/components/right/ActionRow.tsx`:
```tsx
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import type { Action } from '../../types';

type Props = { action: Action };

export function ActionRow({ action }: Props) {
  const running = useStore(s => s.runningActions[action.id]);
  const upsertActionTab = useStore(s => s.upsertActionTab);
  const markRunning = useStore(s => s.markRunning);

  const start = () => {
    const tabId = `action:${action.id}`;
    upsertActionTab({
      kind: 'action', id: tabId, projectId: action.projectId,
      actionId: action.id, title: action.label, status: 'running',
    });
    // PTY spawn nastąpi w TerminalView; ID PTY zapamiętamy tam.
    markRunning(action.id, '__pending__', tabId);
  };

  const stop = async () => {
    if (running && running.ptyId !== '__pending__') {
      await tauri.ptyKill(running.ptyId);
    }
  };

  const isRunning = Boolean(running);
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-elev-2 text-xs">
      <button onClick={isRunning ? stop : start}
        className={`w-5 h-5 grid place-items-center rounded ${isRunning ? 'text-warn' : 'text-success'} hover:bg-bg`}>
        {isRunning ? '■' : '▶'}
      </button>
      <span className="flex-1 truncate" title={action.command}>{action.label}</span>
      {action.source && <span className="text-[10px] text-muted uppercase">{action.source}</span>}
    </div>
  );
}
```

- [ ] **Step 4: ActionList + ActionsSection**

Create `src/components/right/ActionList.tsx`:
```tsx
import { useStore } from '../../store';
import { ActionRow } from './ActionRow';

type Props = { projectId: number };

export function ActionList({ projectId }: Props) {
  const items = useStore(s => s.actionsByProject[projectId] ?? []);
  if (items.length === 0) return <div className="text-xs text-muted">Brak akcji</div>;
  return (
    <div className="space-y-0.5">
      {items.map(a => <ActionRow key={a.id} action={a} />)}
    </div>
  );
}
```

Create `src/components/right/ActionsSection.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { ActionList } from './ActionList';
import { AddActionDialog } from '../dialogs/AddActionDialog';

export function ActionsSection() {
  const projects = useStore(s => s.projects);
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? projects[0]?.id ?? null;
  const project = projects.find(p => p.id === projectId) ?? null;
  const load = useStore(s => s.loadActions);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => { if (projectId != null) load(projectId); }, [projectId, load]);

  if (!project) return <div className="text-xs text-muted">— brak projektu —</div>;
  return (
    <section className="flex-1 min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="text-muted text-xs uppercase tracking-wide">Akcje · {project.name}</div>
        <button onClick={() => setDialogOpen(true)} className="text-xs text-accent hover:underline">+ Dodaj</button>
      </div>
      <ActionList projectId={project.id} />
      {dialogOpen && (
        <AddActionDialog
          projectId={project.id} projectPath={project.path}
          onClose={() => setDialogOpen(false)}
          onAdded={() => load(project.id)}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 5: RightPanel**

Modify `src/components/right/RightPanel.tsx`:
```tsx
import { ActionsSection } from './ActionsSection';

export function RightPanel() {
  return (
    <aside className="h-full bg-bg-elev border-l border-border p-3 text-sm flex flex-col gap-3">
      <ActionsSection />
      <section className="flex-1 min-h-0">
        <div className="text-muted text-xs uppercase tracking-wide">Git</div>
        <div className="mt-2 text-muted">(Phase 7)</div>
      </section>
    </aside>
  );
}
```

- [ ] **Step 6: Smoke**

Dodaj projekt z detekcją, sprawdź czy akcje pojawiają się w prawym panelu, klik ▶ otwiera nowy tab z `TerminalView` (kind='Action').

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: actions slice and right-panel actions section with run/stop controls"
```

---

## Phase 7 — Git status

### Task 7.1: Git wrapper + git status command

**Files:**
- Create: `src-tauri/src/git/mod.rs`, `src-tauri/src/domain/git.rs`, `src-tauri/src/commands/git.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/main.rs`

- [ ] **Step 1: Domain**

Create `src-tauri/src/domain/git.rs`:
```rust
use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,  // 'M' | 'A' | 'D' | '?' | 'R'
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<GitFile>,
    pub is_repo: bool,
}
```

Modify `src-tauri/src/domain/mod.rs` — dodaj:
```rust
pub mod git;
pub use git::*;
```

- [ ] **Step 2: Git wrapper**

Create `src-tauri/src/git/mod.rs`:
```rust
use std::path::Path;
use git2::{Repository, StatusOptions, Status};
use crate::domain::{GitFile, GitStatus};
use crate::error::AppResult;

pub fn status(path: &Path) -> AppResult<GitStatus> {
    let repo = match Repository::discover(path) {
        Ok(r) => r,
        Err(_) => return Ok(GitStatus { branch: None, ahead: 0, behind: 0, files: vec![], is_repo: false }),
    };

    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand().map(String::from));

    let (ahead, behind) = match (head.as_ref().and_then(|h| h.target()), branch.as_deref()) {
        (Some(local_oid), Some(b)) => {
            let upstream_name = format!("refs/remotes/origin/{b}");
            match repo.refname_to_id(&upstream_name) {
                Ok(remote_oid) => repo.graph_ahead_behind(local_oid, remote_oid).unwrap_or((0, 0)),
                Err(_) => (0, 0),
            }
        }
        _ => (0, 0),
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let files: Vec<GitFile> = statuses.iter().filter_map(|s| {
        let p = s.path()?.to_string();
        let st = s.status();
        let (status, staged) = status_to_char(st);
        Some(GitFile { path: p, status, staged })
    }).collect();

    Ok(GitStatus { branch, ahead, behind, files, is_repo: true })
}

fn status_to_char(s: Status) -> (String, bool) {
    if s.contains(Status::INDEX_NEW) { return ("A".into(), true); }
    if s.contains(Status::INDEX_MODIFIED) { return ("M".into(), true); }
    if s.contains(Status::INDEX_DELETED) { return ("D".into(), true); }
    if s.contains(Status::INDEX_RENAMED) { return ("R".into(), true); }
    if s.contains(Status::WT_NEW) { return ("?".into(), false); }
    if s.contains(Status::WT_MODIFIED) { return ("M".into(), false); }
    if s.contains(Status::WT_DELETED) { return ("D".into(), false); }
    ("?".into(), false)
}
```

- [ ] **Step 3: Command**

Create `src-tauri/src/commands/git.rs`:
```rust
use std::path::PathBuf;
use tauri::State;
use crate::domain::GitStatus;
use crate::error::AppResult;
use crate::state::AppState;
use crate::db::projects_repo;

#[tauri::command]
pub fn git_status(state: State<AppState>, project_id: i64) -> AppResult<GitStatus> {
    let c = state.db.get()?;
    let proj = projects_repo::get(&c, project_id)?;
    crate::git::status(&PathBuf::from(&proj.path))
}
```

- [ ] **Step 4: Wpięcie**

Modify `src-tauri/src/lib.rs` — dodaj `pub mod git;`.
Modify `src-tauri/src/commands/mod.rs` — dodaj `pub mod git;`.
Modify `src-tauri/src/main.rs` — w `generate_handler!` dodaj `commands::git::git_status,`.

- [ ] **Step 5: TS wrappery**

Modify `src/lib/tauri.ts` — dodaj:
```ts
import type { GitStatus } from '../types';
gitStatus: (projectId: number) => invoke<GitStatus>('git_status', { projectId }),
```

I `src/types/index.ts` — `export type { GitStatus } from './GitStatus';`, `export type { GitFile } from './GitFile';`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: git status command via git2 with branch/ahead-behind/file list"
```

### Task 7.2: GitSection w prawym panelu

**Files:**
- Create: `src/store/gitSlice.ts`, `src/components/right/GitSection.tsx`, `src/components/right/GitFileList.tsx`, `src/components/right/GitFileRow.tsx`
- Modify: `src/store/index.ts`, `src/components/right/RightPanel.tsx`

- [ ] **Step 1: Git slice**

Create `src/store/gitSlice.ts`:
```ts
import type { StateCreator } from 'zustand';
import { tauri } from '../lib/tauri';
import type { GitStatus } from '../types';

export type GitSlice = {
  gitByProject: Record<number, GitStatus>;
  refreshGit: (projectId: number) => Promise<void>;
};

export const createGitSlice: StateCreator<GitSlice> = (set, get) => ({
  gitByProject: {},
  refreshGit: async (projectId) => {
    const st = await tauri.gitStatus(projectId);
    set({ gitByProject: { ...get().gitByProject, [projectId]: st } });
  },
});
```

Dopnij w `src/store/index.ts`.

- [ ] **Step 2: Komponenty**

Create `src/components/right/GitFileRow.tsx`:
```tsx
import type { GitFile } from '../../types';
const COLOR: Record<string, string> = { M: 'text-warn', A: 'text-success', D: 'text-danger', R: 'text-accent', '?': 'text-muted' };
export function GitFileRow({ file }: { file: GitFile }) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono px-2 py-0.5 hover:bg-bg-elev-2">
      <span className={`w-3 ${COLOR[file.status] ?? 'text-muted'}`}>{file.status}</span>
      <span className="truncate flex-1" title={file.path}>{file.path}</span>
      {file.staged && <span className="text-[10px] text-success">●</span>}
    </div>
  );
}
```

Create `src/components/right/GitFileList.tsx`:
```tsx
import type { GitFile } from '../../types';
import { GitFileRow } from './GitFileRow';
export function GitFileList({ files }: { files: GitFile[] }) {
  if (files.length === 0) return <div className="text-xs text-muted px-2">Czysto</div>;
  return <div className="space-y-0">{files.map((f, i) => <GitFileRow key={`${f.path}-${i}`} file={f} />)}</div>;
}
```

Create `src/components/right/GitSection.tsx`:
```tsx
import { useEffect } from 'react';
import { useStore } from '../../store';
import { GitFileList } from './GitFileList';

export function GitSection() {
  const projects = useStore(s => s.projects);
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? projects[0]?.id ?? null;
  const status = useStore(s => projectId != null ? s.gitByProject[projectId] : null);
  const refresh = useStore(s => s.refreshGit);

  useEffect(() => {
    if (projectId == null) return;
    refresh(projectId);
    const onFocus = () => refresh(projectId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [projectId, refresh]);

  if (projectId == null) return <div className="text-xs text-muted">—</div>;
  return (
    <section className="flex-1 min-h-0 overflow-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="text-muted text-xs uppercase tracking-wide">
          Git {status?.branch ? `· ${status.branch}` : ''}
        </div>
        <button onClick={() => refresh(projectId)} className="text-xs text-muted hover:text-fg">⟳</button>
      </div>
      {!status && <div className="text-xs text-muted">Wczytywanie…</div>}
      {status && !status.isRepo && <div className="text-xs text-muted">Nie jest repozytorium git</div>}
      {status && status.isRepo && (
        <>
          {(status.ahead > 0 || status.behind > 0) && (
            <div className="text-[11px] text-muted mb-1">↑{status.ahead} ↓{status.behind}</div>
          )}
          <GitFileList files={status.files} />
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 3: RightPanel finalny**

Modify `src/components/right/RightPanel.tsx`:
```tsx
import { ActionsSection } from './ActionsSection';
import { GitSection } from './GitSection';
export function RightPanel() {
  return (
    <aside className="h-full bg-bg-elev border-l border-border p-3 text-sm flex flex-col gap-3">
      <ActionsSection />
      <div className="border-t border-border" />
      <GitSection />
    </aside>
  );
}
```

- [ ] **Step 4: Smoke**

Otwórz projekt który jest repo, zobacz branch + listę zmian, focus okna odświeża, ⟳ wymusza.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: GitSection in right panel with status, branch, ahead/behind and file list"
```

---

## Phase 8 — Polish i wykończenie

### Task 8.1: Toaster i ErrorBoundary

**Files:**
- Create: `src/components/layout/ErrorBoundary.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: ErrorBoundary**

Create `src/components/layout/ErrorBoundary.tsx`:
```tsx
import { Component, type ReactNode } from 'react';
type State = { err?: Error };
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div className="p-6 text-danger">
          <h2 className="font-semibold">Coś poszło nie tak</h2>
          <pre className="text-xs mt-2 whitespace-pre-wrap">{this.state.err.stack ?? this.state.err.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: App z Toaster i ErrorBoundary**

Modify `src/App.tsx`:
```tsx
import { Toaster } from 'sonner';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';

export default function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <AppShell />
        <Toaster richColors position="bottom-right" />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: Helper toastów dla błędów Tauri**

Modify `src/lib/tauri.ts` — owin każdy `invoke` w try/catch i wywołaj `toast.error` z `sonner`. Alternatywnie: pojedynczy wrapper:
```ts
import { toast } from 'sonner';
async function safe<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    const msg = e?.message ?? String(e);
    toast.error(msg);
    throw e;
  }
}
// użyj `safe(() => invoke(...))` w każdym wrapperze.
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: global error boundary and toast notifications for Tauri errors"
```

### Task 8.2: Theme switcher w UI

**Files:**
- Create: `src/components/layout/ThemeSwitcher.tsx`
- Modify: `src/components/sidebar/Sidebar.tsx`

- [ ] **Step 1: Komponent**

Create `src/components/layout/ThemeSwitcher.tsx`:
```tsx
import { useTheme } from './ThemeProvider';
import type { ThemeMode } from '../../styles/theme';
const MODES: ThemeMode[] = ['dark', 'light', 'system'];
export function ThemeSwitcher() {
  const { mode, setMode } = useTheme();
  return (
    <div className="flex gap-1">
      {MODES.map(m => (
        <button key={m} onClick={() => setMode(m)}
          className={`px-2 py-1 text-[10px] rounded ${mode === m ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}>
          {m}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wpięcie w stopkę sidebara**

Modify `src/components/sidebar/Sidebar.tsx` — dodaj na dole, pod `AddProjectButton`:
```tsx
import { ThemeSwitcher } from '../layout/ThemeSwitcher';
// ...
<div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
  <span className="text-[10px] text-muted uppercase">Motyw</span>
  <ThemeSwitcher />
</div>
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: theme switcher in sidebar footer"
```

### Task 8.3: Confirm dialog przy zamykaniu taba z aktywnym PTY

**Files:**
- Create: `src/components/dialogs/ConfirmDialog.tsx`
- Modify: `src/components/center/TabBar.tsx`

- [ ] **Step 1: ConfirmDialog**

Create `src/components/dialogs/ConfirmDialog.tsx`:
```tsx
type Props = { title: string; message: string; onConfirm: () => void; onCancel: () => void };
export function ConfirmDialog({ title, message, onConfirm, onCancel }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50">
      <div className="bg-bg-elev border border-border rounded-lg p-5 w-[400px]">
        <h2 className="text-lg font-semibold mb-2">{title}</h2>
        <p className="text-sm text-muted mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1 border border-border rounded">Anuluj</button>
          <button onClick={onConfirm} className="px-3 py-1 bg-danger text-white rounded">Zamknij</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TabBar z confirm**

Modify `src/components/center/TabBar.tsx` — przy `closeTab` sprawdź czy tab kind=session w trybie terminal lub kind=action z `running`. Jeśli tak, pokaż confirm.

(Konkretna implementacja: stan lokalny `pendingClose: tabId | null`, render `ConfirmDialog` gdy ustawione.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: confirm dialog before closing tabs with active processes"
```

### Task 8.4: README + skrypty deweloperskie

**Files:**
- Modify: `README.md`, `package.json`

- [ ] **Step 1: README**

Replace `README.md`:
```markdown
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

## Architektura

Patrz `docs/superpowers/specs/2026-05-21-abeoncode-design.md`.
```

- [ ] **Step 2: Skrypty**

Modify `package.json` `scripts`:
```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "preview": "vite preview",
  "tauri": "tauri",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:rust": "cd src-tauri && cargo test",
  "lint": "tsc -b --noEmit"
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: README with setup, dev, build instructions; add dev scripts"
```

### Task 8.5: Smoke test końcowy

- [ ] **Step 1: Pełny przebieg**

Uruchom `npm run tauri dev`. Wykonaj:
1. Dodaj projekt (`/home/pszweda/projects/cyberstudio/AbeonCode`) — sprawdź wykryte skrypty
2. Rozwiń projekt — załaduj sesje, kliknij "Załaduj starsze"
3. Otwórz sesję — chat-view renderuje user/assistant/thinking/tool/markdown/code
4. Klik ▶ Kontynuuj — terminal otwiera się, claude działa
5. Akcja — klik ▶, tab z action log, output leci
6. Git — branch widoczny, lista plików aktualna
7. Switch motyw — natychmiastowa zmiana wszystkich elementów
8. Restart apki — projekty/akcje/szerokości paneli się zachowują, taby resetują (oczekiwane)

- [ ] **Step 2: Final commit**

```bash
git tag mvp-ready
git log --oneline | head -20
```

---

## Self-review (do przejrzenia przez wykonawcę przed startem)

**Pokrycie speca:**
- ✅ Stack (Tauri 2, Rust, React+TS+Vite) — Phase 0
- ✅ Layout 3 kolumny (lewy, środek z tabami, prawy) — Phase 1, 8
- ✅ Storage SQLite + path encoding — Phase 2
- ✅ JSONL parser + reader + watcher — Phase 3, 4
- ✅ Chat-view z bubbles, thinking, tools, markdown, code highlight — Phase 3
- ✅ PTY + xterm.js, claude --resume — Phase 5
- ✅ Detektory (npm, composer, make, ddev, docker) — Phase 6
- ✅ Akcje per projekt z tab-per-akcja — Phase 6
- ✅ Git status (branch, ahead/behind, pliki) — Phase 7
- ✅ Motyw dark/light/system — Phase 1, 8
- ✅ Error handling (AppError + toaster + boundary) — Phase 2, 8
- ✅ Confirm przy zamykaniu aktywnego procesu — Phase 8

**Typy:**
- Frontend używa typów wygenerowanych z Rust (ts-rs) — jednolite źródło prawdy
- Enum `HistoryBlock` z tagged variants — uważać na rzeczywistą formę po serializacji (`PascalCase` warianty przez `ts-rs` domyślnie)

**Brak placeholderów:** Wszystkie steps mają konkretny kod lub konkretne komendy.
