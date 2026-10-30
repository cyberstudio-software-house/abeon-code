import { useStore } from '../../store';
import { Icon } from '../shared/Icon';
import { SETTINGS_CATEGORIES, SETTINGS_GROUPS, type SettingsCategoryId } from '../../lib/settingsCategories';

export function SettingsNav({ categories, active, terminalNew, onSelect }: {
  categories: SettingsCategoryId[];
  active: SettingsCategoryId;
  terminalNew: boolean;
  onSelect: (id: SettingsCategoryId) => void;
}) {
  const skipPermissions = useStore(s => s.skipPermissions);

  return (
    <nav aria-label="Kategorie ustawień" className="flex flex-col gap-[14px]">
      {SETTINGS_GROUPS.map(group => {
        const items = group.categories.filter(id => categories.includes(id));
        if (items.length === 0) return null;
        return (
          <div key={group.id} className="flex flex-col gap-0.5">
            <h2 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.06em] text-label">{group.label}</h2>
            {items.map(id => {
              const category = SETTINGS_CATEGORIES[id];
              const current = id === active;
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => onSelect(id)}
                  className={`flex h-[30px] items-center gap-2.5 rounded-[7px] px-2 text-left text-[13px] transition-colors ${
                    current ? 'bg-bg-elev-2 text-fg-strong' : 'text-fg-secondary hover:bg-bg-elev-2 hover:text-fg'
                  }`}
                >
                  <Icon
                    name={category.icon}
                    className={`h-[15px] w-[15px] shrink-0 ${current ? '' : 'text-muted'}`}
                    strokeWidth={2.25}
                  />
                  <span className="min-w-0 flex-1 truncate">{category.label}</span>
                  {id === 'terminal' && terminalNew && (
                    <span className="rounded-full bg-accent/[0.14] px-[7px] py-px text-[10.5px] font-medium text-accent">Nowe</span>
                  )}
                  {id === 'permissions' && skipPermissions && (
                    <span className="font-mono text-[10.5px] text-accent">bypass</span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
