/**
 * Convert a workspace-relative path into a POSIX style string for display or
 * tool output. Keeps `.` as-is for the workspace root.
 */
export function toPosixPath(relativePath: string): string {
  if (!relativePath || relativePath === '.') {
    return '.';
  }

  return relativePath.split(/[\\/]/).join('/');
}
