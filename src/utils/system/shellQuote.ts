/**
 * Quote a value for safe use as a single POSIX shell word: wrap in single
 * quotes and escape embedded single quotes via the `'\''` idiom.
 */
export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
