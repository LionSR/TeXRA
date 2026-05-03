import fixPath from 'fix-path';
import { delimiter } from 'node:path';

const MACOS_PATH_ENTRIES = [
  '/Library/TeX/texbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

function prependMissingPathEntries(
  pathValue: string | undefined,
  entries: readonly string[],
): string {
  const parts = (pathValue ?? '').split(delimiter).filter(Boolean);
  for (const entry of entries.toReversed()) {
    if (!parts.includes(entry)) parts.unshift(entry);
  }
  return parts.join(delimiter);
}

export function repairLaunchPath(): string {
  if (process.platform === 'darwin') {
    fixPath();
    process.env.PATH = prependMissingPathEntries(
      process.env.PATH,
      MACOS_PATH_ENTRIES,
    );
  }
  return process.env.PATH ?? '';
}
