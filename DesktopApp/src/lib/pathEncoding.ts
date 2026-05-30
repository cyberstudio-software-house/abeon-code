export function encodeProjectPath(absolutePath: string): string {
  return absolutePath.replace(/\//g, '-');
}
