import { describe, it, expect } from 'vitest';
import type { Project } from '../types';
import { filterProjects, clampIndex } from './projectLauncher';

const mk = (id: number, name: string, path: string): Project => ({
  id, name, path, claudeDir: '', color: null, sortOrder: id, createdAt: 0,
});

const projects = [
  mk(1, 'AbeonCode', '/home/me/abeon/code'),
  mk(2, 'Mobile', '/home/me/abeon/mobile'),
  mk(3, 'Docs', '/var/www/docs-site'),
];

describe('filterProjects', () => {
  it('returns all projects in input order for a blank query', () => {
    expect(filterProjects(projects, '')).toEqual(projects);
    expect(filterProjects(projects, '   ')).toEqual(projects);
  });

  it('matches by name, case-insensitively', () => {
    expect(filterProjects(projects, 'mob').map(p => p.id)).toEqual([2]);
    expect(filterProjects(projects, 'ABEONCODE').map(p => p.id)).toEqual([1]);
  });

  it('matches by path', () => {
    expect(filterProjects(projects, '/var/www').map(p => p.id)).toEqual([3]);
    expect(filterProjects(projects, 'abeon').map(p => p.id)).toEqual([1, 2]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterProjects(projects, 'zzz')).toEqual([]);
  });

  it('preserves input order among matches', () => {
    expect(filterProjects(projects, 'o').map(p => p.id)).toEqual([1, 2, 3]);
  });
});

describe('clampIndex', () => {
  it('clamps to the lower bound', () => {
    expect(clampIndex(-1, 3)).toBe(0);
  });

  it('clamps to the upper bound', () => {
    expect(clampIndex(5, 3)).toBe(2);
  });

  it('returns 0 for an empty list', () => {
    expect(clampIndex(0, 0)).toBe(0);
    expect(clampIndex(2, 0)).toBe(0);
  });

  it('passes through an in-range index', () => {
    expect(clampIndex(1, 3)).toBe(1);
  });
});
