import type { Tab } from '../store/tabsSlice';
import type { Project } from '../types';

export type TabGroup = {
  projectId: number;
  name: string;
  tabs: Tab[];
};

export const GROUP_COLORS = [
  '#6a9fb5',
  '#b58a6a',
  '#8ab56a',
  '#b56a9f',
  '#6ab5a8',
  '#b5a86a',
  '#8a6ab5',
  '#b56a6a',
];

export function getGroupColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

export function groupTabsByProject(tabs: Tab[], projects: Project[]): TabGroup[] {
  const map = new Map<number, TabGroup>();
  for (const tab of tabs) {
    if (!map.has(tab.projectId)) {
      const proj = projects.find(p => p.id === tab.projectId);
      map.set(tab.projectId, { projectId: tab.projectId, name: proj?.name ?? 'Unknown', tabs: [] });
    }
    map.get(tab.projectId)!.tabs.push(tab);
  }
  return Array.from(map.values());
}
