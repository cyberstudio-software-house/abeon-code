# Session duration + project summary modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session duration (wall-clock span + active time) to the "Zużycie" section, and move the project usage total out of that section into a dedicated project-summary modal opened from the project context menu.

**Architecture:** Duration is computed Rust-side by capturing per-line RFC3339 timestamps inside the existing `UsageAccumulator` (which already reads every session line), then folded into `UsageSummary` as two nullable fields so it rides the existing `session:{id}:usage` live-event path. The frontend drops the project line from `UsageSection`, adds two duration lines, and introduces `ProjectSummaryDialog` that reuses the existing `project_usage` + `count_sessions` commands.

**Tech Stack:** Rust (Tauri 2, serde, chrono, ts-rs), React 19 + TypeScript, Zustand, Tailwind 4, Vitest, cargo test.

## Global Constraints

- Identifiers in English only; user-facing UI text in Polish.
- No code comments unless WHY is non-obvious; match surrounding style.
- Conventional Commits 1.0.0, scope `usage` / `desktop`; no co-author trailer.
- `npm run lint` (= `tsc -b --noEmit`) must report zero errors.
- ts-rs exports `src/types/*.ts` during `cargo test`, NOT `cargo build` — run `cargo test` once after changing `#[derive(TS)]` structs to materialize the file.
- `Option<i64>` crossing IPC needs `#[ts(type = "number | null")]` (see `domain/subagent.rs`, `domain/git.rs`).
- Active-time idle threshold is fixed at 5 minutes (`ACTIVE_GAP_MS = 300_000`).
- All Rust/npm commands run from `DesktopApp/`.

---

### Task 1: Backend — session duration in `UsageAccumulator` + `UsageSummary`

**Files:**
- Modify: `src-tauri/src/domain/usage.rs` (add two fields to `UsageSummary`)
- Modify: `src-tauri/src/sessions/usage.rs` (capture timestamps, compute duration in `finalize`, tests)
- Modify: `src-tauri/src/commands/usage.rs:66-74` (empty-dir literal → `UsageAccumulator::default().finalize()`)
- Regenerated: `src/types/UsageSummary.ts` (via `cargo test`)

**Interfaces:**
- Produces: `UsageSummary { …, duration_ms: Option<i64>, active_ms: Option<i64> }` → TS `UsageSummary { …, durationMs: number | null, activeMs: number | null }`. `duration_ms` = wall-clock span (last − first timestamp, ms); `active_ms` = Σ inter-event gaps ≤ 5 min; both `None`/`null` when the source has no timestamps.

- [ ] **Step 1: Add the failing duration test to `sessions/usage.rs`**

Add inside the existing `mod tests` block:

```rust
    #[test]
    fn session_span_and_active_time_from_timestamps() {
        let mut acc = UsageAccumulator::default();
        for ts in [
            "2026-07-31T10:00:00Z",
            "2026-07-31T10:02:00Z",
            "2026-07-31T10:30:00Z",
            "2026-07-31T10:31:00Z",
        ] {
            acc.add_line(&json!({ "type": "user", "timestamp": ts }));
        }
        let s = acc.finalize();
        assert_eq!(s.duration_ms, Some(31 * 60 * 1000));
        assert_eq!(s.active_ms, Some(3 * 60 * 1000));
    }

    #[test]
    fn duration_none_without_timestamps() {
        let mut acc = UsageAccumulator::default();
        acc.add_line(&assistant("a", "claude-opus-4-7", 100, 10, 0, 0));
        let s = acc.finalize();
        assert_eq!(s.duration_ms, None);
        assert_eq!(s.active_ms, None);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session_span_and_active_time_from_timestamps`
Expected: compile error — `UsageSummary` has no field `duration_ms` / `add_line` does not record timestamps.

- [ ] **Step 3: Add the two fields to `UsageSummary` in `domain/usage.rs`**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub tokens: TokenTotals,
    pub cost_usd: f64,
    pub by_model: Vec<ModelUsage>,
    pub unknown_models: Vec<String>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
    #[ts(type = "number | null")]
    pub active_ms: Option<i64>,
}
```

- [ ] **Step 4: Capture timestamps and compute duration in `sessions/usage.rs`**

Add the idle-gap constant near the top of the file (after the imports):

```rust
const ACTIVE_GAP_MS: i64 = 5 * 60 * 1000;
```

Add a timestamp helper next to `u64_at`:

```rust
fn ts_ms(line: &Value) -> Option<i64> {
    line.get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
}
```

Add the field to the accumulator:

```rust
#[derive(Default)]
pub struct UsageAccumulator {
    seen: HashSet<String>,
    by_model: HashMap<String, RawTokens>,
    timestamps: Vec<i64>,
}
```

Record the timestamp for every line in `add_line` (before the usage branch):

```rust
    pub fn add_line(&mut self, line: &Value) {
        if let Some(ms) = ts_ms(line) {
            self.timestamps.push(ms);
        }
        if let Some((model, key, tokens)) = extract_usage(line) {
            if !key.is_empty() && !self.seen.insert(key) {
                return;
            }
            self.by_model.entry(model).or_default().add(&tokens);
        }
    }
```

Compute duration in `finalize` and add it to the returned struct. Add a free function below `cost_of`:

```rust
fn duration_of(timestamps: &[i64]) -> (Option<i64>, Option<i64>) {
    if timestamps.is_empty() {
        return (None, None);
    }
    let mut ts = timestamps.to_vec();
    ts.sort_unstable();
    let span = ts[ts.len() - 1] - ts[0];
    let active = ts.windows(2).map(|w| w[1] - w[0]).filter(|g| *g <= ACTIVE_GAP_MS).sum();
    (Some(span), Some(active))
}
```

Update the tail of `finalize` (the `UsageSummary { … }` return literal):

```rust
        let (duration_ms, active_ms) = duration_of(&self.timestamps);

        UsageSummary {
            tokens: total.display(),
            cost_usd: cost_total,
            by_model,
            unknown_models,
            duration_ms,
            active_ms,
        }
```

- [ ] **Step 5: Fix the empty-dir constructor in `commands/usage.rs`**

Replace the hand-written literal in `project_usage` (the `if !dir.exists()` branch, lines ~67-74):

```rust
    if !dir.exists() {
        return Ok(UsageAccumulator::default().finalize());
    }
```

(`UsageAccumulator` is already imported at the top of the file.)

- [ ] **Step 6: Run the backend tests to verify they pass (and regenerate the TS type)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml usage`
Expected: PASS, including the two new tests and all pre-existing `usage::tests`.

- [ ] **Step 7: Confirm the ts-rs export regenerated**

Run: `git diff --stat src/types/UsageSummary.ts`
Expected: the file now contains `durationMs: number | null, activeMs: number | null`.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/domain/usage.rs src-tauri/src/sessions/usage.rs src-tauri/src/commands/usage.rs src/types/UsageSummary.ts
git commit -m "feat(usage): licz czas trwania i czas aktywny sesji"
```

---

### Task 2: Frontend — `formatDuration` helper

**Files:**
- Modify: `src/lib/formatUsage.ts`
- Modify: `src/lib/formatUsage.test.ts`

**Interfaces:**
- Produces: `formatDuration(ms: number): string` — `"2h 14m"` when ≥ 1h, `"3m 20s"` when ≥ 1m, `"45s"` otherwise; `formatDuration(0) === "0s"`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/formatUsage.test.ts`:

```ts
import { formatDuration } from './formatUsage';

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
  });
  it('formats minutes with seconds', () => {
    expect(formatDuration(200_000)).toBe('3m 20s');
  });
  it('formats hours with minutes', () => {
    expect(formatDuration(8_040_000)).toBe('2h 14m');
  });
});
```

(If `formatUsage.test.ts` has no top-level `import { describe, it, expect }`, Vitest globals are already enabled in this project — check the existing file header and match it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- formatUsage`
Expected: FAIL — `formatDuration is not a function`.

- [ ] **Step 3: Implement `formatDuration` in `src/lib/formatUsage.ts`**

```ts
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- formatUsage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/formatUsage.ts src/lib/formatUsage.test.ts
git commit -m "feat(usage): helper formatDuration"
```

---

### Task 3: Frontend — `UsageSection`: drop project line, add duration lines

**Files:**
- Modify: `src/components/right/UsageSection.tsx`
- Modify: `src/components/right/UsageSection.test.tsx`

**Interfaces:**
- Consumes: `UsageSummary.durationMs` / `.activeMs` (Task 1), `formatDuration` (Task 2).

- [ ] **Step 1: Update the test to reflect the new layout**

Replace `src/components/right/UsageSection.test.tsx` body with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageSection } from './UsageSection';

vi.mock('../../lib/tauri', () => ({
  tauri: {
    sessionUsage: vi.fn().mockResolvedValue(null),
    onSessionUsage: vi.fn().mockResolvedValue(() => {}),
  },
}));

vi.mock('../../store', () => ({
  useStore: (selector: (s: unknown) => unknown) =>
    selector({ tabs: [], activeTabId: null }),
}));

describe('UsageSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders session, duration and active-time lines with placeholders when no active tab', () => {
    render(<UsageSection />);
    expect(screen.getByText('Sesja')).toBeInTheDocument();
    expect(screen.getByText('Czas sesji')).toBeInTheDocument();
    expect(screen.getByText('Czas aktywny')).toBeInTheDocument();
    expect(screen.queryByText('Projekt')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- UsageSection`
Expected: FAIL — `Czas sesji` not found / `Projekt` still present.

- [ ] **Step 3: Rewrite `UsageSection.tsx`**

Replace the file with (removes `projectUsage` state/effect/refresh + `IconBtn`; adds duration lines):

```tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { tauri } from '../../lib/tauri';
import { formatTokens, formatCost, formatDuration } from '../../lib/formatUsage';
import type { UsageSummary } from '../../types';

function totalTokens(u: UsageSummary): number {
  return u.tokens.input + u.tokens.output + u.tokens.cacheWrite + u.tokens.cacheRead;
}

function UsageLine({ label, usage }: { label: string; usage: UsageSummary | null }) {
  if (!usage) {
    return (
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted">{label}</span>
        <span className="text-muted">—</span>
      </div>
    );
  }
  const unknown = usage.unknownModels.length > 0;
  const tooltip = usage.byModel
    .map(m => `${m.model}: ${formatTokens(m.tokens.input + m.tokens.output + m.tokens.cacheWrite + m.tokens.cacheRead)} tok · ${formatCost(m.costUsd)}`)
    .join('\n')
    + (unknown ? `\n(brak ceny: ${usage.unknownModels.join(', ')})` : '');
  return (
    <div className="flex items-center justify-between text-[12px]" title={tooltip}>
      <span className="text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-fg-secondary tabular-nums">{formatTokens(totalTokens(usage))} tok</span>
        <span className="text-fg font-medium tabular-nums">~{formatCost(usage.costUsd)}</span>
        {unknown && <span className="text-warn" title="Część modeli bez ceny">*</span>}
      </span>
    </div>
  );
}

function DurationLine({ label, ms }: { label: string; ms: number | null | undefined }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-muted">{label}</span>
      <span className={ms != null ? 'text-fg-secondary tabular-nums' : 'text-muted'}>
        {ms != null ? formatDuration(ms) : '—'}
      </span>
    </div>
  );
}

export function UsageSection() {
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activeTab = tabs.find(t => t.id === activeTabId);
  const projectId = activeTab?.projectId ?? null;
  const sessionId = activeTab?.kind === 'session' ? activeTab.sessionId : null;

  const [sessionUsage, setSessionUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    setSessionUsage(null);
    if (projectId == null || sessionId == null) return;
    let unlisten: (() => void) | null = null;
    tauri.sessionUsage(projectId, sessionId).then(setSessionUsage).catch(() => {});
    tauri.onSessionUsage(sessionId, setSessionUsage).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [projectId, sessionId]);

  return (
    <section className="shrink-0">
      <div className="mb-2">
        <span className="text-[10px] text-muted font-medium uppercase tracking-wider">Zużycie</span>
      </div>
      <div className="flex flex-col gap-1">
        <UsageLine label="Sesja" usage={sessionUsage} />
        <DurationLine label="Czas sesji" ms={sessionUsage?.durationMs} />
        <DurationLine label="Czas aktywny" ms={sessionUsage?.activeMs} />
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- UsageSection`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/right/UsageSection.tsx src/components/right/UsageSection.test.tsx
git commit -m "feat(usage): pokaz czas sesji i usun linie projektu z sekcji zuzycia"
```

---

### Task 4: Frontend — `chart` icon + `ProjectSummaryDialog`

**Files:**
- Modify: `src/components/shared/Icon.tsx` (add `chart` glyph)
- Create: `src/components/dialogs/ProjectSummaryDialog.tsx`
- Create: `src/components/dialogs/ProjectSummaryDialog.test.tsx`

**Interfaces:**
- Consumes: `tauri.projectUsage(projectId): Promise<UsageSummary>`, `tauri.countSessions(projectId): Promise<number>`, `formatTokens`, `formatCost`.
- Produces: `ProjectSummaryDialog({ project, onClose })` component (used by Task 5).

- [ ] **Step 1: Add the `chart` icon to `Icon.tsx`**

Insert into the `paths` record (after `layers`):

```tsx
  chart:    <g><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></g>,
```

- [ ] **Step 2: Write the failing dialog test**

Create `src/components/dialogs/ProjectSummaryDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectSummaryDialog } from './ProjectSummaryDialog';
import type { Project } from '../../types';

const usage = {
  tokens: { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 },
  costUsd: 1.23,
  byModel: [{ model: 'claude-opus-4-8', tokens: { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 }, costUsd: 1.23 }],
  unknownModels: [],
  durationMs: null,
  activeMs: null,
};

vi.mock('../../lib/tauri', () => ({
  tauri: {
    projectUsage: vi.fn().mockResolvedValue(usage),
    countSessions: vi.fn().mockResolvedValue(5),
  },
}));

const project = { id: 1, name: 'Demo', path: '/x', claudeDir: 'x', color: null } as unknown as Project;

describe('ProjectSummaryDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders session count, cost and per-model row', async () => {
    render(<ProjectSummaryDialog project={project} onClose={() => {}} />);
    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(await screen.findByText('claude-opus-4-8')).toBeInTheDocument();
    expect(await screen.findByText(/1\.23/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- ProjectSummaryDialog`
Expected: FAIL — cannot resolve `./ProjectSummaryDialog`.

- [ ] **Step 4: Implement `ProjectSummaryDialog.tsx`**

Create `src/components/dialogs/ProjectSummaryDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Project, UsageSummary } from '../../types';
import { tauri } from '../../lib/tauri';
import { formatTokens, formatCost } from '../../lib/formatUsage';

type Props = { project: Project; onClose: () => void };

function totalTokens(u: UsageSummary): number {
  return u.tokens.input + u.tokens.output + u.tokens.cacheWrite + u.tokens.cacheRead;
}

export function ProjectSummaryDialog({ project, onClose }: Props) {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([tauri.projectUsage(project.id), tauri.countSessions(project.id)])
      .then(([u, c]) => { if (active) { setUsage(u); setCount(c); } })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [project.id]);

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50" onClick={onClose}>
      <div className="bg-bg-elev border border-border p-5 w-[460px]" onClick={e => e.stopPropagation()}>
        <h2 className="text-[14px] font-semibold mb-3">Podsumowanie — {project.name}</h2>
        {loading ? (
          <div className="text-[12px] text-muted py-4">Ładowanie…</div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 mb-4 text-[12px]">
              <div className="flex justify-between"><span className="text-muted">Sesje</span><span className="tabular-nums">{count ?? '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted">Tokeny</span><span className="tabular-nums">{usage ? `${formatTokens(totalTokens(usage))} tok` : '—'}</span></div>
              <div className="flex justify-between"><span className="text-muted">Koszt</span><span className="tabular-nums font-medium">{usage ? `~${formatCost(usage.costUsd)}` : '—'}</span></div>
            </div>
            {usage && usage.byModel.length > 0 && (
              <table className="w-full text-[11.5px] mb-3">
                <thead>
                  <tr className="text-muted text-left">
                    <th className="font-medium pb-1">Model</th>
                    <th className="font-medium pb-1 text-right">Tokeny</th>
                    <th className="font-medium pb-1 text-right">Koszt</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map(m => (
                    <tr key={m.model} className="border-t border-border">
                      <td className="py-1 pr-2 truncate max-w-[220px]">{m.model}</td>
                      <td className="py-1 text-right tabular-nums">{formatTokens(m.tokens.input + m.tokens.output + m.tokens.cacheWrite + m.tokens.cacheRead)}</td>
                      <td className="py-1 text-right tabular-nums">{formatCost(m.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {usage && usage.unknownModels.length > 0 && (
              <div className="text-[11px] text-warn mb-2">Bez ceny: {usage.unknownModels.join(', ')}</div>
            )}
          </>
        )}
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 border border-border text-[12px] text-fg-secondary hover:text-fg">Zamknij</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- ProjectSummaryDialog`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/shared/Icon.tsx src/components/dialogs/ProjectSummaryDialog.tsx src/components/dialogs/ProjectSummaryDialog.test.tsx
git commit -m "feat(usage): modal podsumowania projektu"
```

---

### Task 5: Frontend — menu item + `ProjectItem` wiring

**Files:**
- Modify: `src/components/sidebar/ProjectManageMenu.tsx`
- Modify: `src/components/sidebar/ProjectManageMenu.test.tsx`
- Modify: `src/components/sidebar/ProjectItem.tsx`

**Interfaces:**
- Consumes: `ProjectSummaryDialog` (Task 4), `chart` icon (Task 4).
- Produces: `ProjectManageMenu` gains a required `onSummary: () => void` prop.

- [ ] **Step 1: Update `ProjectManageMenu.test.tsx`**

Replace the "renders edit and delete items" test and add a summary test; every render now passes `onSummary`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectManageMenu } from './ProjectManageMenu';

describe('ProjectManageMenu', () => {
  it('renders summary, edit and delete items', () => {
    render(<ProjectManageMenu onSummary={() => {}} onEdit={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Podsumowanie')).toBeInTheDocument();
    expect(screen.getByText('Edytuj')).toBeInTheDocument();
    expect(screen.getByText('Usuń')).toBeInTheDocument();
  });

  it('fires onSummary then onClose when Podsumowanie is clicked', () => {
    const onSummary = vi.fn(); const onClose = vi.fn();
    render(<ProjectManageMenu onSummary={onSummary} onEdit={() => {}} onDelete={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByText('Podsumowanie'));
    expect(onSummary).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fires onEdit then onClose when Edytuj is clicked', () => {
    const onEdit = vi.fn(); const onClose = vi.fn();
    render(<ProjectManageMenu onSummary={() => {}} onEdit={onEdit} onDelete={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByText('Edytuj'));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fires onDelete then onClose when Usuń is clicked', () => {
    const onDelete = vi.fn(); const onClose = vi.fn();
    render(<ProjectManageMenu onSummary={() => {}} onEdit={() => {}} onDelete={onDelete} onClose={onClose} />);
    fireEvent.click(screen.getByText('Usuń'));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ProjectManageMenu`
Expected: FAIL — `Podsumowanie` not found / `onSummary` type error.

- [ ] **Step 3: Add the menu item in `ProjectManageMenu.tsx`**

```tsx
import { Icon } from '../shared/Icon';

type Props = { onSummary: () => void; onEdit: () => void; onDelete: () => void; onClose: () => void };

export function ProjectManageMenu({ onSummary, onEdit, onDelete, onClose }: Props) {
  return (
    <div role="menu" className="py-1">
      <button
        role="menuitem"
        onClick={() => { onSummary(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="chart" className="w-3 h-3" strokeWidth={2} />
        <span>Podsumowanie</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onEdit(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-fg hover:bg-bg-elev"
      >
        <Icon name="pencil" className="w-3 h-3" strokeWidth={2} />
        <span>Edytuj</span>
      </button>
      <button
        role="menuitem"
        onClick={() => { onDelete(); onClose(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-danger hover:bg-danger/10"
      >
        <Icon name="trash" className="w-3 h-3" strokeWidth={2} />
        <span>Usuń</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Wire the dialog in `ProjectItem.tsx`**

Add the import near the other dialog imports:

```tsx
import { ProjectSummaryDialog } from '../dialogs/ProjectSummaryDialog';
```

Add state next to the existing `useState` hooks (near `const [editing, setEditing] = useState(false);`):

```tsx
  const [summaryOpen, setSummaryOpen] = useState(false);
```

Pass `onSummary` to `ProjectManageMenu` (update the existing usage around line 89):

```tsx
            <ProjectManageMenu
              onSummary={() => setSummaryOpen(true)}
              onEdit={() => setEditing(true)}
              onDelete={() => setConfirmingDelete(true)}
              onClose={() => setManageOpen(false)}
            />
```

Render the dialog alongside `EditProjectDialog` (after the `{editing && …}` line):

```tsx
      {summaryOpen && <ProjectSummaryDialog project={project} onClose={() => setSummaryOpen(false)} />}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- ProjectManageMenu`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebar/ProjectManageMenu.tsx src/components/sidebar/ProjectManageMenu.test.tsx src/components/sidebar/ProjectItem.tsx
git commit -m "feat(desktop): pozycja Podsumowanie w menu projektu otwiera modal"
```

---

### Task 6: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Type-check the whole frontend**

Run: `npm run lint`
Expected: zero errors.

- [ ] **Step 2: Run the full frontend test suite**

Run: `npm test`
Expected: all pass (new + existing).

- [ ] **Step 3: Run the full backend test suite**

Run: `npm run test:rust`
Expected: all pass.

- [ ] **Step 4: Manual smoke check (documented, run by the user)**

Run `npm run tauri dev`, open a Claude session tab, and confirm: the "Zużycie" section shows "Sesja", "Czas sesji", "Czas aktywny" (no "Projekt" line, no refresh button); right-click a project (or the "…" button) → "Podsumowanie" opens the modal with session count, totals and a per-model table.

---

## Self-Review

**Spec coverage:**
- Session duration (span + active) → Task 1 (backend) + Task 3 (UI lines) + Task 2 (formatter). ✓
- 5-min idle threshold → Task 1 `ACTIVE_GAP_MS`. ✓
- Duration folded into `UsageSummary`, live via existing event → Task 1 (no watcher/command signature change). ✓
- Remove project line + refresh button from section → Task 3. ✓
- Project summary modal (session count + tokens + cost + per-model table + unknown note) → Task 4. ✓
- Trigger from "Zarządzaj projektem" menu → Task 5. ✓
- Tests (Rust finalize, formatDuration, UsageSection, ProjectSummaryDialog, ProjectManageMenu) → Tasks 1-5. ✓
- ts-rs regeneration → Task 1 Steps 6-7. ✓

**Placeholder scan:** none — every code step carries full content.

**Type consistency:** `durationMs` / `activeMs` (`number | null`) used identically in Tasks 1, 3, 4; `onSummary: () => void` defined in Task 5 Step 3 and consumed in Task 5 Step 4; `ProjectSummaryDialog({ project, onClose })` produced in Task 4 and consumed in Task 5; `chart` icon added in Task 4 and used in Task 5.
