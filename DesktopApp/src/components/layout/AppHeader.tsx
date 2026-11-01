import { useStore } from '../../store';
import { getProjectColor } from '../../lib/projectColors';
import { SETTINGS_CATEGORIES } from '../../lib/settingsCategories';
import { HeaderProjectRow } from '../center/HeaderProjectRow';

const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

export type AppHeaderVariant =
  | { kind: 'main' }
  | { kind: 'project'; projectId: number }
  | { kind: 'session' };

function LogoMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 120 120" aria-hidden="true" className="shrink-0">
      <rect width="120" height="120" rx="27" fill="#16162A" />
      <circle cx="58" cy="60" r="19" fill="none" stroke="#F2F3F4" strokeWidth="12" />
      <rect x="71" y="35" width="15" height="50" rx="2.5" fill="#7B6FF7" />
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

function SettingsBreadcrumb() {
  const label = useStore(s => SETTINGS_CATEGORIES[s.settingsCategory].label);
  return (
    <nav
      aria-label="Ścieżka"
      data-tauri-drag-region
      className="flex-1 min-w-0 flex items-center gap-2 text-[12.5px] text-icon whitespace-nowrap"
    >
      <span>Ustawienia</span>
      <span aria-hidden className="text-faint">/</span>
      <span className="truncate text-fg-strong">{label}</span>
    </nav>
  );
}

const HEADER_PADDING_LEFT = IS_MAC ? 78 : 16;
const MAIN_HEADER_GAP = 16;
const SHELL_BODY_PADDING = 4;

export function AppHeader({ variant }: { variant: AppHeaderVariant }) {
  const showSettingsBreadcrumb = useStore(s => variant.kind === 'main' && s.settingsOpen);
  const leftWidth = useStore(s => s.leftWidth);
  const logoBlockWidth = Math.max(0, leftWidth + SHELL_BODY_PADDING - HEADER_PADDING_LEFT - MAIN_HEADER_GAP);
  return (
    <header
      data-tauri-drag-region
      className="h-11 shrink-0 flex items-center select-none"
      style={{ paddingLeft: HEADER_PADDING_LEFT, paddingRight: 8, gap: variant.kind === 'main' ? MAIN_HEADER_GAP : 12 }}
    >
      {variant.kind === 'main' ? (
        <div data-tauri-drag-region style={{ width: logoBlockWidth }} className="shrink-0 flex items-center gap-2.5 overflow-hidden">
          <LogoMark />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">AbeonCode</span>
        </div>
      ) : (
        <LogoMark />
      )}
      {variant.kind === 'project'
        ? <ProjectBreadcrumb projectId={variant.projectId} />
        : showSettingsBreadcrumb ? <SettingsBreadcrumb /> : <HeaderProjectRow />}
      <ActiveSessionsCount label={variant.kind === 'main' ? 'aktywne sesje' : 'aktywne'} />
    </header>
  );
}
