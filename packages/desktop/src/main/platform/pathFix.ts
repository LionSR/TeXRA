import { delimiter } from 'node:path';
import fixPath from 'fix-path';

const MACOS_PATH_ENTRIES = [
  '/Library/TeX/texbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

interface LaunchPathRepairOptions {
  env?: Pick<NodeJS.ProcessEnv, 'PATH'>;
  fixPath?: () => void;
  platform?: NodeJS.Platform;
}

export function prependMissingPathEntries(
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
  return repairLaunchPathWithOptions();
}

export function repairLaunchPathWithOptions(
  options: LaunchPathRepairOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    (options.fixPath ?? fixPath)();
    env.PATH = prependMissingPathEntries(env.PATH, MACOS_PATH_ENTRIES);
  }
  return env.PATH ?? '';
}
