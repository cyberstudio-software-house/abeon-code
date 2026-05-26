# Tab Grouping by Project

## Problem

When tabs from multiple projects are open, the flat tab list gives no visual indication of which tab belongs to which project. With many tabs, they overflow the container and become inaccessible.

## Solution

Group tabs by `projectId` with collapsible group headers and horizontal scroll with arrow buttons for overflow.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Group visual | Collapsible headers with colored bottom border | Best for many tabs, clear visual grouping |
| Overflow | Horizontal scroll with arrow buttons | Standard pattern (VS Code, Chrome), discoverable |
| Single project | Hide group header | No noise when grouping isn't needed |
| Collapsed state | Project name + tab count badge | Compact and informative |
| Group colors | Auto-assigned from fixed palette | Zero config, deterministic by project index |
| State management | Pure derived state (Approach A) | Zero store changes, grouping computed in render, collapse in local useState |

## Visual Design

### Multi-project expanded

```
[▼ AbeonCode] [› New session ×] [◇ fix auth]  ···  [▼ OtherProject] [$ Terminal] [▶ npm test]
 ═══════════════════════════════════════════         ═══════════════════════════════════════════
       (blue 2px border-bottom)                            (orange 2px border-bottom)
```

- Group header: `▼`/`▶` chevron + project name in accent color, `font-weight:600`
- Colored `border-bottom: 2px solid <accent>` spans the entire group (header + all tabs)
- 8px spacer between groups

### Collapsed group

```
[▼ AbeonCode] [› New session ×] [◇ fix auth]  ···  [▶ OtherProject (2)]
 ═══════════════════════════════════════════          ═══════════════════
```

- Shows `▶ ProjectName` + count badge
- Badge styled with project accent color at reduced opacity (`color33` background)
- Clicking the header or badge expands the group

### Single project

```
[› New session ×] [◇ fix auth]
```

- No group header, no border — identical to current behavior
- Condition: all tabs share the same `projectId` (or `uniqueProjectIds.length <= 1`)

### Overflow

```
‹  [▼ AbeonCode] [› New session ×] [◇ fix auth] [◇ refactor db] ...  ›
```

- Left/right arrow buttons appear when `scrollWidth > clientWidth`
- Arrows have gradient background (fade from `bg` to transparent) so content doesn't hard-clip
- Click scrolls by a fixed amount (~200px), hold for continuous scroll not required (click-repeat is sufficient)
- Mouse wheel on the tab bar scrolls horizontally (translate `deltaY` to `scrollLeft`)
- Active tab auto-scrolls into view when activated (via `scrollIntoView`)

## Architecture

### Color Palette

A fixed array of 6-8 visually distinct colors defined as a constant in `TabBar.tsx` (or a shared `lib/colors.ts` if reused elsewhere). Color assigned by: `palette[projectIndex % palette.length]` where `projectIndex` is the index of the project in the grouped array (not `projectId` — this keeps adjacent groups always different).

Suggested palette (dark-theme friendly):
```ts
const GROUP_COLORS = [
  '#6a9fb5', // steel blue
  '#b58a6a', // warm tan
  '#8ab56a', // sage green
  '#b56a9f', // muted magenta
  '#6ab5a8', // teal
  '#b5a86a', // gold
  '#8a6ab5', // lavender
  '#b56a6a', // muted red
];
```

### Grouping Logic (derived in render)

```ts
const groups = useMemo(() => {
  const map = new Map<number, { projectId: number; name: string; tabs: Tab[] }>();
  for (const tab of tabs) {
    if (!map.has(tab.projectId)) {
      const proj = projects.find(p => p.id === tab.projectId);
      map.set(tab.projectId, {
        projectId: tab.projectId,
        name: proj?.name ?? 'Unknown',
        tabs: [],
      });
    }
    map.get(tab.projectId)!.tabs.push(tab);
  }
  return Array.from(map.values());
}, [tabs, projects]);
```

Tab ordering within a group preserves the original `tabs` array order (insertion order).

### Collapse State

```ts
const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
const toggleCollapse = (projectId: number) =>
  setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
    return next;
  });
```

Local to `TabBar`. Resets on app restart (clean slate, acceptable).

### Show Groups Condition

```ts
const showGroups = groups.length > 1;
```

When `false`, render flat tabs exactly as today — no headers, no borders.

### Scroll Overflow

The scrollable container is the inner flex div holding all groups. Wrap it in a container with `overflow-x: auto` (hidden scrollbar via CSS) and two absolutely/flex-positioned arrow buttons.

Overflow detection:
```ts
const scrollRef = useRef<HTMLDivElement>(null);
const [canScrollLeft, setCanScrollLeft] = useState(false);
const [canScrollRight, setCanScrollRight] = useState(false);

useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;
  const check = () => {
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  check();
  el.addEventListener('scroll', check);
  const ro = new ResizeObserver(check);
  ro.observe(el);
  return () => { el.removeEventListener('scroll', check); ro.disconnect(); };
}, [tabs, collapsed]);
```

Scroll actions:
- Arrow click: `el.scrollBy({ left: ±200, behavior: 'smooth' })`
- Mouse wheel: `onWheel` handler translates `deltaY` to horizontal scroll
- Active tab: `scrollIntoView({ block: 'nearest', inline: 'nearest' })` when `activeTabId` changes

Arrow visibility: render both arrows always, but set `opacity-0 pointer-events-none` when `!canScrollLeft` / `!canScrollRight`.

### Clicking a Tab in a Collapsed Group

Not possible — collapsed groups don't show individual tabs. The user must expand the group first by clicking the header. When expanding a group that contains the active tab, the active tab becomes visible and auto-scrolls into view.

### Interaction: Activating a Tab Switches to its Group

When the user activates a tab via `setActive()` from outside TabBar (e.g., sidebar session click), the tab's group should auto-expand if collapsed. This requires a `useEffect` watching `activeTabId`:

```ts
useEffect(() => {
  if (!active) return;
  const tab = tabs.find(t => t.id === active);
  if (tab && collapsed.has(tab.projectId)) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.delete(tab.projectId);
      return next;
    });
  }
}, [active]);
```

## Files to Modify

| File | Change |
|------|--------|
| `src/components/center/TabBar.tsx` | Main implementation: grouping logic, collapse state, scroll overflow, group headers, colored borders |
| `src/components/center/TabBar.tsx` (CSS) | Tailwind classes for group containers, scroll arrows, gradient overlays, hidden scrollbar |

No store changes. No new files needed (palette constant lives in TabBar.tsx).

## Edge Cases

- **Tab opened for deleted project**: `projects.find()` returns `undefined` → group name falls back to `'Unknown'`
- **All tabs in a group closed**: group disappears from the `groups` array naturally
- **Last multi-project tab closed** (drops to 1 project): `showGroups` flips to `false`, headers disappear, collapse state becomes irrelevant
- **New tab opens in collapsed group**: group auto-expands (same `useEffect` as above, triggered by `activeTabId` changing to the new tab)
- **Drag-and-drop reorder**: not in scope — tabs maintain insertion order within groups

## Out of Scope

- Per-project color customization (auto-palette only)
- Drag-and-drop tab reordering between groups
- Persisting collapse state across app restarts
- Tab pinning
