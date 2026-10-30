import { useEffect, useId, useMemo, useState, type ComponentType } from 'react';
import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import { SidebarFooter } from '../sidebar/SidebarFooter';
import {
  filterSettingsCategories, isTerminalCategorySeen, markTerminalCategorySeen, type SettingsCategoryId,
} from '../../lib/settingsCategories';
import { SettingsNav } from './SettingsNav';
import { GeneralCategory } from './categories/GeneralCategory';
import { AppearanceCategory } from './categories/AppearanceCategory';
import { TerminalCategory } from './categories/TerminalCategory';
import { NotificationsCategory } from './categories/NotificationsCategory';
import { ShortcutsCategory } from './categories/ShortcutsCategory';
import { ProvidersCategory } from './categories/ProvidersCategory';
import { ModelsCategory } from './categories/ModelsCategory';
import { PermissionsCategory } from './categories/PermissionsCategory';
import { SupervisorCategory } from './categories/SupervisorCategory';
import { CloudCategory } from './categories/CloudCategory';
import { ClickUpCategory } from './categories/ClickUpCategory';

const CATEGORY_PAGES: Record<SettingsCategoryId, ComponentType> = {
  general: GeneralCategory,
  appearance: AppearanceCategory,
  terminal: TerminalCategory,
  notifications: NotificationsCategory,
  shortcuts: ShortcutsCategory,
  providers: ProvidersCategory,
  models: ModelsCategory,
  permissions: PermissionsCategory,
  supervisor: SupervisorCategory,
  cloud: CloudCategory,
  clickup: ClickUpCategory,
};

export function SettingsView() {
  const category = useStore(s => s.settingsCategory);
  const setSettingsCategory = useStore(s => s.setSettingsCategory);
  const closeSettings = useStore(s => s.closeSettings);
  const leftWidth = useStore(s => s.leftWidth);
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [terminalSeen, setTerminalSeen] = useState(isTerminalCategorySeen);
  const visibleCategories = useMemo(() => filterSettingsCategories(query), [query]);

  useEffect(() => {
    if (category !== 'terminal') return;
    markTerminalCategorySeen();
    setTerminalSeen(true);
  }, [category]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      closeSettings();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeSettings]);

  const changeQuery = (value: string) => {
    setQuery(value);
    const matches = filterSettingsCategories(value);
    if (matches.length > 0 && !matches.includes(category)) setSettingsCategory(matches[0]);
  };

  const Page = CATEGORY_PAGES[category];

  return (
    <div className="absolute inset-x-0 top-11 bottom-0 z-40 flex bg-bg px-1 pb-1">
      <div style={{ width: leftWidth }} className="h-full shrink-0 p-1">
        <div className="flex h-full flex-col gap-[14px] px-1 pt-1">
          <button
            type="button"
            onClick={closeSettings}
            className="flex h-8 shrink-0 items-center gap-2 rounded-[8px] px-2 text-left text-[13px] text-fg-secondary transition-colors hover:bg-bg-elev-2 hover:text-fg"
          >
            <Icon name="arrowLeft" className="h-[15px] w-[15px] shrink-0" strokeWidth={2.25} />
            <span className="flex-1">Wróć do sesji</span>
            <kbd className="rounded-[5px] border border-border-strong px-[5px] py-px font-mono text-[10.5px] text-icon">Esc</kbd>
          </button>
          <div className="relative shrink-0">
            <label htmlFor={searchId} className="sr-only">Szukaj w ustawieniach</label>
            <Icon
              name="search"
              className="pointer-events-none absolute left-[11px] top-[10px] h-3.5 w-3.5 text-muted"
              strokeWidth={2.25}
            />
            <input
              id={searchId}
              value={query}
              onChange={e => changeQuery(e.target.value)}
              placeholder="Szukaj w ustawieniach"
              className="h-[34px] w-full rounded-[9px] border border-border bg-bg-elev pl-8 pr-2.5 text-[12.5px] text-fg placeholder:text-muted"
            />
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <SettingsNav
              categories={visibleCategories}
              active={category}
              terminalNew={!terminalSeen}
              onSelect={setSettingsCategory}
            />
          </div>
          <SidebarFooter showSettingsButton={false} />
        </div>
      </div>
      <div
        key={category}
        className="scroll-thin m-1 min-w-0 flex-1 overflow-auto rounded-[12px] border border-border bg-bg-elev px-12 py-10"
      >
        <Page />
      </div>
    </div>
  );
}
