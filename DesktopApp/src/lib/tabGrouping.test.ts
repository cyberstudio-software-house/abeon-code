// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { groupTabsByProject } from './tabGrouping';
import { getProjectColor } from './projectColors';
import type { Tab } from '../store/tabsSlice';

const tab = (id: string, projectId: number, kind: Tab['kind'] = 'session'): Tab => {
  if (kind === 'session') return { kind: 'session', id, projectId, sessionId: id, title: id, mode: 'history' };
  if (kind === 'terminal') return { kind: 'terminal', id, projectId, title: id };
  return { kind: 'action', id, projectId, actionId: 1, title: id, status: 'running' };
};

const projects = [
  { id: 1, name: 'Alpha', path: '/a', claudeDir: '', color: null, sortOrder: 0, createdAt: 0 },
  { id: 2, name: 'Beta', path: '/b', claudeDir: '', color: '#123456', sortOrder: 1, createdAt: 0 },
];

describe('groupTabsByProject', () => {
  it('groups tabs by projectId preserving insertion order', () => {
    const tabs = [tab('a', 1), tab('b', 2), tab('c', 1)];
    const groups = groupTabsByProject(tabs, projects);
    expect(groups).toHaveLength(2);
    expect(groups[0].projectId).toBe(1);
    expect(groups[0].name).toBe('Alpha');
    expect(groups[0].tabs.map(t => t.id)).toEqual(['a', 'c']);
    expect(groups[1].projectId).toBe(2);
    expect(groups[1].tabs.map(t => t.id)).toEqual(['b']);
  });

  it('returns empty array for no tabs', () => {
    expect(groupTabsByProject([], projects)).toEqual([]);
  });

  it('falls back to "Unknown" for missing project', () => {
    const tabs = [tab('x', 999)];
    const groups = groupTabsByProject(tabs, projects);
    expect(groups[0].name).toBe('Unknown');
  });

  it('preserves tab order within a group', () => {
    const tabs = [tab('a', 1), tab('b', 1), tab('c', 1)];
    const groups = groupTabsByProject(tabs, projects);
    expect(groups[0].tabs.map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('group color', () => {
  it('derives the color from the project, independent of group order', () => {
    const order1 = groupTabsByProject([tab('a', 1), tab('b', 2)], projects);
    const order2 = groupTabsByProject([tab('b', 2), tab('a', 1)], projects);
    const color1 = (id: number) => order1.find(g => g.projectId === id)!.color;
    const color2 = (id: number) => order2.find(g => g.projectId === id)!.color;
    expect(color1(1)).toBe(color2(1));
    expect(color1(2)).toBe(color2(2));
  });

  it('honors a manually set project color', () => {
    const groups = groupTabsByProject([tab('b', 2)], projects);
    expect(groups[0].color).toBe('#123456');
  });

  it('uses the id-derived color for projects without a manual color', () => {
    const groups = groupTabsByProject([tab('a', 1)], projects);
    expect(groups[0].color).toBe(getProjectColor({ id: 1, color: null }));
  });

  it('still assigns a color for an unknown project', () => {
    const groups = groupTabsByProject([tab('x', 999)], projects);
    expect(groups[0].color).toBe(getProjectColor({ id: 999, color: null }));
  });
});
