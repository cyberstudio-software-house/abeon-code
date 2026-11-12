import { describe, expect, it } from 'vitest';
import type { GitFile, GitStatus } from '../types';
import { gitStatusByPath } from './fileGitStatus';

const file = (path: string, status: string): GitFile => ({ path, status, staged: false, additions: 0, deletions: 0 });
const repo = (label: string, files: GitFile[]) => ({ label, branch: 'main', ahead: 0, behind: 0, files });

describe('gitStatusByPath', () => {
  it('keeps root repository paths as they are', () => {
    const status: GitStatus = { isRepo: true, repos: [repo('.', [file('src/a.ts', 'M')])] };
    expect(gitStatusByPath(status).get('src/a.ts')).toBe('M');
  });

  it('prefixes paths of nested repositories with their label', () => {
    const status: GitStatus = {
      isRepo: true,
      repos: [repo('api', [file('src/a.ts', 'A')]), repo('web', [file('b.ts', '?')])],
    };
    const byPath = gitStatusByPath(status);
    expect(byPath.get('api/src/a.ts')).toBe('A');
    expect(byPath.get('web/b.ts')).toBe('?');
    expect(byPath.has('src/a.ts')).toBe(false);
  });

  it('returns an empty map without a status', () => {
    expect(gitStatusByPath(undefined).size).toBe(0);
  });
});
