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

function prependMissingPathEntries(
  pathValue: string | undefined,
  entries: readonly string[],
  separator: string,
): string {
  const parts = (pathValue ?? '').split(separator).filter(Boolean);
  for (const entry of entries.toReversed()) {
    if (!parts.includes(entry)) parts.unshift(entry);
  }
  return parts.join(separator);
}

export function repairLaunchPath(
  options: LaunchPathRepairOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    if (options.fixPath != null) {
      options.fixPath();
    } else if (env === process.env) {
      fixPath();
    }
    // ':' is the POSIX PATH separator; this branch only runs on darwin.
    env.PATH = prependMissingPathEntries(env.PATH, MACOS_PATH_ENTRIES, ':');
  }
  return env.PATH ?? '';
}
