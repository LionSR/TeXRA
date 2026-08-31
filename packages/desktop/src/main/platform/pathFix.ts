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
  platform?: NodeJS.Platform;
}

export function repairLaunchPath(
  options: LaunchPathRepairOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    // Only the real process environment goes through fix-path; injected
    // environments get the deterministic prepend below only.
    if (env === process.env) fixPath();
    // ':' is the POSIX PATH separator; this branch only runs on darwin.
    const parts = (env.PATH ?? '').split(':').filter(Boolean);
    for (const entry of MACOS_PATH_ENTRIES.toReversed()) {
      if (!parts.includes(entry)) parts.unshift(entry);
    }
    env.PATH = parts.join(':');
  }
  return env.PATH ?? '';
}
