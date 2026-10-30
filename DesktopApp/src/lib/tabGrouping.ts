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

export function pickProjectTab(tabs: Tab[], mruOrder: string[], projectId: number): string | undefined {
  return mruOrder.find(id => tabs.some(t => t.id === id && t.projectId === projectId))
    ?? tabs.find(t => t.projectId === projectId)?.id;
}
