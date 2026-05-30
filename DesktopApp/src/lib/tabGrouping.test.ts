// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { groupTabsByProject, getGroupColor, GROUP_COLORS } from './tabGrouping';
import type { Tab } from '../store/tabsSlice';

const tab = (id: string, projectId: number, kind: Tab['kind'] = 'session'): Tab => {
  if (kind === 'session') return { kind: 'session', id, projectId, sessionId: id, title: id, mode: 'history' };
  if (kind === 'terminal') return { kind: 'terminal', id, projectId, title: id };
  return { kind: 'action', id, projectId, actionId: 1, title: id, status: 'running' };
};

const projects = [
  { id: 1, name: 'Alpha', path: '/a', claudeDir: '', color: null, sortOrder: 0, createdAt: 0 },
  { id: 2, name: 'Beta', path: '/b', claudeDir: '', color: null, sortOrder: 1, createdAt: 0 },
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

describe('getGroupColor', () => {
  it('returns different colors for different indices', () => {
    expect(getGroupColor(0)).not.toBe(getGroupColor(1));
  });

  it('wraps around the palette', () => {
    expect(getGroupColor(0)).toBe(getGroupColor(GROUP_COLORS.length));
  });
});

describe('GROUP_COLORS', () => {
  it('has at least 6 colors', () => {
    expect(GROUP_COLORS.length).toBeGreaterThanOrEqual(6);
  });

  it('all entries are valid hex colors', () => {
    for (const c of GROUP_COLORS) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
