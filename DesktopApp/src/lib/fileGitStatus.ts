import type { GitStatus } from '../types';

export function gitStatusByPath(status: GitStatus | undefined): Map<string, string> {
  const byPath = new Map<string, string>();
  if (!status) return byPath;
  for (const repo of status.repos) {
    for (const file of repo.files) {
      byPath.set(repo.label === '.' ? file.path : `${repo.label}/${file.path}`, file.status);
    }
  }
  return byPath;
}
