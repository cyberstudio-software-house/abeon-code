import type { Tab } from '../store/tabsSlice';
import type { Project } from '../types';
import { getProjectColor } from './projectColors';

export type TabGroup = {
  projectId: number;
  name: string;
  color: string;
  tabs: Tab[];
};

export function groupTabsByProject(tabs: Tab[], projects: Project[]): TabGroup[] {
  const map = new Map<number, TabGroup>();
  for (const tab of tabs) {
    if (!map.has(tab.projectId)) {
      const proj = projects.find(p => p.id === tab.projectId);
      map.set(tab.projectId, {
        projectId: tab.projectId,
        name: proj?.name ?? 'Unknown',
        color: getProjectColor(proj ?? { id: tab.projectId, color: null }),
        tabs: [],
      });
    }
    map.get(tab.projectId)!.tabs.push(tab);
  }
  return Array.from(map.values());
}

export type TabBarItem =
  | { kind: 'single'; tab: Tab; color: string }
  | { kind: 'group'; projectId: number; name: string; color: string; tabs: Tab[] };

export function layoutTabBar(tabs: Tab[], projects: Project[]): TabBarItem[] {
  const groups = groupTabsByProject(tabs, projects);
  const singles = new Map(groups.filter(g => g.tabs.length === 1).map(g => [g.projectId, g]));
  const hoisted: TabBarItem[] = tabs
    .filter(t => singles.has(t.projectId))
    .map(t => ({ kind: 'single', tab: t, color: singles.get(t.projectId)!.color }));
  const rest: TabBarItem[] = groups
    .filter(g => g.tabs.length > 1)
    .map(g => ({ kind: 'group', projectId: g.projectId, name: g.name, color: g.color, tabs: g.tabs }));
  return [...hoisted, ...rest];
}
