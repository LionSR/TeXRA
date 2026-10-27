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

export function repairLaunchPath(): void {
  if (process.platform !== 'darwin') return;
  fixPath();
  // ':' is the POSIX PATH separator; this only runs on darwin.
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean);
  const missing = MACOS_PATH_ENTRIES.filter((entry) => !parts.includes(entry));
  process.env.PATH = [...missing, ...parts].join(':');
}
