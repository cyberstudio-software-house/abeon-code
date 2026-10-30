export function drawerShellLabel(shellPath: string): string {
  const name = shellPath.split(/[\\/]/).filter(Boolean).pop();
  return name ?? 'Terminal';
}
