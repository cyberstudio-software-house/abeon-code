import type { Project } from '../types';

export const PROJECT_COLORS = [
  '#b78640',
  '#c2483d',
  '#4a9d5b',
  '#4a7dc2',
  '#8b5cc2',
  '#6b7280',
  '#cf7a3a',
  '#b3a53f',
  '#7ba33f',
  '#3fa882',
  '#3f9fb0',
  '#b75fa0',
  '#c2566f',
  '#5b6ac2',
] as const;

export function getProjectColor(project: Pick<Project, 'id' | 'color'>): string {
  if (project.color) return project.color;
  const n = PROJECT_COLORS.length;
  return PROJECT_COLORS[((project.id % n) + n) % n];
}
