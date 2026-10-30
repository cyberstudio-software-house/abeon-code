import { useStore } from '../../store';
import { getProjectColor } from '../../lib/projectColors';
import { HeaderProjectRow } from '../center/HeaderProjectRow';

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

export type AppHeaderVariant =
  | { kind: 'main' }
  | { kind: 'project'; projectId: number }
  | { kind: 'session' };

function LogoMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
      <rect x="1" y="1" width="18" height="18" rx="5" fill="var(--color-accent)" />
      <path
        d="M6.5 7 9.5 10l-3 3M11 13h3"
        fill="none"
        stroke="var(--color-accent-fg)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActiveSessionsCount({ label }: { label: string }) {
  const count = useStore(s =>
    s.tabs.filter(t => (t.kind === 'session' && t.mode === 'terminal') || t.kind === 'terminal').length
    + Object.keys(s.drawerTerminals).length,
  );
  if (count === 0) return null;
  return (
    <span className="flex items-center gap-1.5 px-1.5 shrink-0 whitespace-nowrap text-[12px] text-muted">
      <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-success" />
      {count} {label}
    </span>
  );
}

function ProjectBreadcrumb({ projectId }: { projectId: number }) {
  const project = useStore(s => s.projects.find(p => p.id === projectId));
  const color = getProjectColor(project ?? { id: projectId, color: null });
  return (
    <nav
      aria-label="Ścieżka"
      data-tauri-drag-region
      className="flex-1 min-w-0 flex items-center gap-2 text-[12.5px] text-icon whitespace-nowrap"
    >
      <span className="flex items-center gap-2 min-w-0 font-medium text-fg-strong">
        <span aria-hidden className="w-[7px] h-[7px] rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="truncate">{project?.name ?? 'Projekt'}</span>
      </span>
      <span aria-hidden className="text-faint">/</span>
      <span>Okno projektu</span>
    </nav>
  );
}

export function AppHeader({ variant }: { variant: AppHeaderVariant }) {
  return (
    <header
      data-tauri-drag-region
      className="h-11 shrink-0 flex items-center select-none"
      style={{ paddingLeft: IS_MAC ? 78 : 16, paddingRight: 8, gap: variant.kind === 'main' ? 16 : 12 }}
    >
      {variant.kind === 'main' ? (
        <div data-tauri-drag-region className="w-[224px] shrink-0 flex items-center gap-2.5">
          <LogoMark />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">AbeonCode</span>
        </div>
      ) : (
        <LogoMark />
      )}
      {variant.kind === 'project' ? <ProjectBreadcrumb projectId={variant.projectId} /> : <HeaderProjectRow />}
      <ActiveSessionsCount label={variant.kind === 'main' ? 'aktywne sesje' : 'aktywne'} />
    </header>
  );
}
